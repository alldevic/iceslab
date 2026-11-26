import type { EngineName } from '@iceslab/shared';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { getLogger } from '../../lib/infra/logger.js';
import { escapeMarkdown, notifyTelegramAsync } from '../../lib/notify/telegram-notify.js';
import { issueBootstrapToken } from '../nodes/bootstrap.service.js';
import { readIntendedEngines } from '../nodes/node-intended-engines.js';
import { HotswapController } from './pool.hotswap.js';
import {
  DEFAULT_HOTSWAP_CONFIG,
  type BurnedNode,
  type CarryReport,
  type HotswapDeps,
  type SpareNode,
  type SwapNotice,
} from './pool.types.js';

// The DB-backed side of the cold-pool hotswap (the pure policy lives in
// pool.policy.ts / pool.hotswap.ts). registerPoolEventHandlers is a no-op
// unless EXT_VPTECH_POOL_ENABLED.

interface PoolLabels {
  asn?: string;
  provider?: string;
  burned?: boolean;
  spare?: boolean;
}

export function poolLabels(hardening: unknown): PoolLabels {
  const h = hardening as { pool?: PoolLabels } | null | undefined;
  return h?.pool ?? {};
}

/**
 * The cold pool: nodes in status `disabled` that the operator marked as a spare
 * (`hardening.pool.spare`), excluding the ones already burned. The mark is the
 * only criterion. "Never redeemed a bootstrap token" cannot be one: redeemed
 * tokens are purged by the daily retention job, so after a day a node taken
 * out for maintenance would look as if no agent had ever run on it. `disabled`
 * also keeps a spare out of the status poller: a panel dialling a spare every
 * 30 seconds would find nothing there.
 */
export async function loadColdPool(): Promise<SpareNode[]> {
  const rows = await prisma.node.findMany({
    where: { deletedAt: null, status: 'disabled' },
    select: { id: true, name: true, countryCode: true, consumptionMultiplierTenths: true, hardening: true },
  });
  const spares: SpareNode[] = [];
  for (const r of rows) {
    const labels = poolLabels(r.hardening);
    if (labels.spare !== true) continue;
    if (labels.burned) continue; // a retired IP must never be promoted again
    spares.push({
      id: r.id,
      name: r.name,
      asn: labels.asn ?? null,
      provider: labels.provider ?? null,
      countryCode: r.countryCode ?? null,
      consumptionMultiplier: r.consumptionMultiplierTenths / 10,
    });
  }
  return spares;
}

/** The burned node's diversity labels, for spare selection. */
export async function loadBurnedNode(nodeId: string): Promise<BurnedNode | null> {
  const r = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: { id: true, countryCode: true, hardening: true },
  });
  if (!r) return null;
  const labels = poolLabels(r.hardening);
  return { id: r.id, asn: labels.asn ?? null, provider: labels.provider ?? null, countryCode: r.countryCode ?? null };
}

/** What the installer of a promoted spare gets (the role `iceslab_node`, deploy/ansible). */
export interface ProvisionVars {
  iceslab_panel_url: string;
  iceslab_bootstrap_token: string;
  iceslab_engines: EngineName[];
}

/**
 * Installs a promoted spare. Injectable: tests pass a mock, and the run of the
 * ansible role from the panel replaces the default later.
 */
export interface AnsibleRunner {
  provision(spare: { id: string; name: string }, vars: ProvisionVars): Promise<void>;
}

/**
 * The runner until the panel can run the role itself: it only says what it
 * would have installed. The token stays out of the log.
 */
export const logOnlyAnsibleRunner: AnsibleRunner = {
  async provision(spare, vars) {
    getLogger().warn(
      `[ext-vptech-pool] promote ${spare.name}: no installer wired, nothing installed (engines ${vars.iceslab_engines.join(',') || 'none'}); run deploy/ansible against this node by hand`,
    );
  },
};

export interface PoolDepsOptions {
  runner?: AnsibleRunner;
  schedule?: (fn: () => void, ms: number) => void;
  notify?: (n: SwapNotice) => void;
  /** What carries the burned node's settings onto the spare. Log only until the carry step exists. */
  repoint?: HotswapDeps['repoint'];
}

/** The seam for the carry step: nothing moves, and the alert says so. */
export async function logOnlyRepoint(burnedId: string, spareId: string): Promise<CarryReport> {
  getLogger().info(`[ext-vptech-pool] repoint ${burnedId} -> ${spareId}: bindings are not carried yet`);
  return { carried: 0, total: 0, notes: ['bindings were not carried: move them by hand'] };
}

/**
 * The DB-backed HotswapDeps.
 *
 * promote: a bootstrap token, the install, and the spare leaves `disabled` for
 * `unknown` (what `PUT /api/nodes/:id` with `active` does too, the status poller
 * decides from there) with its spare mark taken off, so an operator who later
 * disables it again does not put it back in the pool.
 *
 * retire: `disabled` + `hardening.pool.burned`. The agent on it is told
 * `disabled` on its heartbeat and stays up, soft-paused.
 */
export function makeHotswapDeps(opts: PoolDepsOptions = {}): HotswapDeps {
  const runner = opts.runner ?? logOnlyAnsibleRunner;
  return {
    now: () => Date.now(),
    log: (m) => getLogger().info(`[ext-vptech-pool] ${m}`),
    schedule:
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      }),
    notify: opts.notify ?? notifySwap,
    loadPool: async (burnedId) => ({ spares: await loadColdPool(), burned: await loadBurnedNode(burnedId) }),

    promote: async (spare) => {
      const row = await prisma.node.findUniqueOrThrow({
        where: { id: spare.id },
        select: { status: true, intendedEngines: true, protocol: true, singboxEngine: true, hardening: true },
      });
      const { token } = await issueBootstrapToken(spare.id);
      await runner.provision(
        { id: spare.id, name: spare.name },
        {
          iceslab_panel_url: config.PUBLIC_URL,
          iceslab_bootstrap_token: token,
          iceslab_engines: readIntendedEngines(row),
        },
      );

      const labels = { ...poolLabels(row.hardening) };
      delete labels.spare;
      const hardening = { ...((row.hardening as object | null) ?? {}), pool: labels };
      await prisma.node.update({
        where: { id: spare.id },
        data: { status: 'unknown', lastStatusChange: new Date(), hardening },
      });
      eventBus.emit('node.changed', { nodeId: spare.id });
      // Written here, not through updateNode, so what that announces is said here:
      // the /sub cache, the cascades and the webhooks follow a status change.
      eventBus.emit('node.status-changed', { nodeId: spare.id, from: row.status, to: 'unknown' });
    },

    repoint: opts.repoint ?? logOnlyRepoint,

    retire: async (burnedId) => {
      const row = await prisma.node.findUniqueOrThrow({ where: { id: burnedId }, select: { status: true, hardening: true } });
      const hardening = {
        ...((row.hardening as object | null) ?? {}),
        pool: { ...poolLabels(row.hardening), burned: true },
      };
      await prisma.node.update({
        where: { id: burnedId },
        data: { status: 'disabled', lastStatusChange: new Date(), hardening },
      });
      eventBus.emit('node.changed', { nodeId: burnedId });
      eventBus.emit('node.status-changed', { nodeId: burnedId, from: row.status, to: 'disabled' });
    },
  };
}

async function nodeNames(ids: string[]): Promise<Map<string, string>> {
  const rows = await prisma.node.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The operator hears about every confirmed incident, whatever came of it. */
function notifySwap(n: SwapNotice): void {
  void (async () => {
    const names = await nodeNames(n.kind === 'no-spare' ? [n.burnedId] : [n.burnedId, n.spareId]);
    const name = (id: string) => `\`${escapeMarkdown(names.get(id) ?? id)}\``;
    if (n.kind === 'swapped') {
      notifyTelegramAsync(
        `🔁 *Node replaced*\nburned: ${name(n.burnedId)}\nspare: ${name(n.spareId)}\n` +
          `bindings: ${n.report.carried}/${n.report.total} carried` +
          n.report.notes.map((x) => `\n• ${escapeMarkdown(x)}`).join(''),
      );
    } else if (n.kind === 'no-spare') {
      notifyTelegramAsync(`🔁 *Node not replaced*\nburned: ${name(n.burnedId)}\nthe cold pool is empty`);
    } else {
      notifyTelegramAsync(
        `🔁 *Node replacement failed* (${n.stage})\nburned: ${name(n.burnedId)}\nspare: ${name(n.spareId)}\n` +
          `error: ${escapeMarkdown(n.error.slice(0, 300))}`,
      );
    }
  })().catch((err: unknown) => {
    getLogger().warn({ err }, '[ext-vptech-pool] swap notice failed');
  });
}

let registered = false;

/**
 * Subscribe the hotswap controller to the anomaly sensor: node.anomaly opens an
 * incident, node.anomaly-cleared closes it, one still open after the
 * confirmation time is swapped. No-op unless EXT_VPTECH_POOL_ENABLED. Once per
 * process: the bus has no `off`, and a second subscription would put two
 * controllers on every incident, each picking a spare for the same burned node.
 * Returns whether it subscribed.
 */
export function registerPoolEventHandlers(opts: PoolDepsOptions = {}): boolean {
  if (!config.EXT_VPTECH_POOL_ENABLED) return false;
  // After the flag, not before: a call made while the pool was off must not
  // use up the one subscription.
  if (registered) return false;
  registered = true;

  const controller = new HotswapController({ ...DEFAULT_HOTSWAP_CONFIG, enabled: true }, makeHotswapDeps(opts));
  eventBus.on('node.anomaly', (ev) => {
    const r = controller.onAnomaly(ev);
    getLogger().info(`[ext-vptech-pool] node.anomaly ${ev.nodeId}: ${r}`);
  });
  eventBus.on('node.anomaly-cleared', ({ nodeId }) => controller.onCleared(nodeId));
  getLogger().info('[ext-vptech-pool] hotswap registered');
  return true;
}
