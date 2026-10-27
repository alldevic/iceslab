import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EngineName } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { getLogger } from '../../lib/infra/logger.js';
import { escapeMarkdown, notifyTelegramAsync } from '../../lib/notify/telegram-notify.js';
import { createBinding } from '../profiles/profiles.service.js';
import { issueBootstrapToken } from '../nodes/bootstrap.service.js';
import { effectiveEngineOf } from '../nodes/node-engines.js';
import { engineSet, nodeProtocolOf, readIntendedEngines } from '../nodes/node-intended-engines.js';
import { readCoreVersions } from '../nodes/node-core-versions.js';
import { getPanelPublicIp } from '../nodes/panel-ip.js';
import { registerNodeWarp, updateNode } from '../nodes/nodes.service.js';
import { HotswapController } from './pool.hotswap.js';
import {
  DEFAULT_HOTSWAP_CONFIG,
  type BurnedNode,
  type HotswapDeps,
  type SpareNode,
  type SwapNotice,
} from './pool.types.js';

// The DB-backed side of the cold-pool hotswap (the pure policy lives in
// pool.policy.ts / pool.hotswap.ts). registerNodePoolHandlers is a no-op
// unless NODE_POOL_HOTSWAP_ENABLED.

interface PoolLabels {
  asn?: string;
  provider?: string;
  burned?: boolean;
}

export function poolLabels(hardening: unknown): PoolLabels {
  const h = hardening as { pool?: PoolLabels } | null | undefined;
  return h?.pool ?? {};
}

/**
 * The cold pool: nodes in status `disabled` that have NEVER redeemed a
 * bootstrap token (no agent ever came up, so the IP is unexposed), excluding
 * the ones already burned. `disabled` keeps them out of the status poller too:
 * a panel dialling a spare every 30 seconds would point at it.
 */
export async function loadColdPool(): Promise<SpareNode[]> {
  const rows = await prisma.node.findMany({
    where: {
      deletedAt: null,
      status: 'disabled',
      bootstrapTokens: { none: { consumedAt: { not: null } } },
    },
    select: { id: true, name: true, countryCode: true, consumptionMultiplierTenths: true, hardening: true },
  });
  const spares: SpareNode[] = [];
  for (const r of rows) {
    const labels = poolLabels(r.hardening);
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

/**
 * The cores the spare is set up with: its own, the burned node's, and every
 * engine a binding that will be carried needs. A node is a set of cores here,
 * and the spare replaces all of the burned one, not its first core.
 */
export function spareEngines(
  spare: readonly EngineName[],
  burned: readonly EngineName[],
  bindings: readonly { protocol: string; engine: string | null }[],
): EngineName[] {
  return engineSet([...spare, ...burned, ...bindings.map(effectiveEngineOf)]);
}

/** What the playbook gets for one spare (deploy/ansible, role iceslab_node). */
export interface ProvisionVars {
  iceslab_panel_url: string;
  iceslab_bootstrap_token: string;
  iceslab_engines: EngineName[];
  iceslab_panel_ip?: string;
  iceslab_harden_ufw?: true;
  iceslab_fail2ban?: true;
  iceslab_ssh_allowlist?: string[];
}

/**
 * Installs a promoted spare. The default runs the node role's playbook limited
 * to the spare, when NODE_POOL_ANSIBLE_PLAYBOOK is set; otherwise it logs a
 * dry run, so the swap can be exercised without a control node. Injectable so
 * tests pass a mock.
 */
export interface AnsibleRunner {
  /** `dryRun: true` when nothing was installed. */
  provision(spare: { id: string; name: string }, vars: ProvisionVars): Promise<{ dryRun: boolean }>;
}

const execFileAsync = promisify(execFile);

export const defaultAnsibleRunner: AnsibleRunner = {
  async provision(spare, vars) {
    const playbook = config.NODE_POOL_ANSIBLE_PLAYBOOK;
    if (!playbook) {
      getLogger().warn(
        `[node-pool] promote ${spare.name}: NODE_POOL_ANSIBLE_PLAYBOOK is not set, dry run, nothing installed (engines ${vars.iceslab_engines.join(',') || 'none'})`,
      );
      return { dryRun: true };
    }
    // Extra vars through a 0600 file, not argv: the bootstrap token would
    // otherwise sit in the process list of the panel host for the whole run.
    // Only what is set goes in: extra vars outrank the inventory, and an empty
    // value here would override the operator's host vars.
    const dir = await mkdtemp(join(tmpdir(), 'node-pool-'));
    const varsFile = join(dir, 'vars.json');
    try {
      await writeFile(varsFile, JSON.stringify(vars), { mode: 0o600 });
      const args = [playbook, '--limit', spare.name, '-e', `@${varsFile}`];
      if (config.NODE_POOL_ANSIBLE_INVENTORY) args.splice(1, 0, '-i', config.NODE_POOL_ANSIBLE_INVENTORY);
      getLogger().info(`[node-pool] promote ${spare.name}: ${config.NODE_POOL_ANSIBLE_BIN} ${args.join(' ')}`);
      const { stdout } = await execFileAsync(config.NODE_POOL_ANSIBLE_BIN, args, {
        timeout: 15 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      });
      getLogger().info(`[node-pool] promote ${spare.name}: ansible done, ${stdout.trim().split('\n').slice(-1)[0]}`);
      return { dryRun: false };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/**
 * Wait for the spare's first report of its cores. The carried bindings go
 * through the same gate as an operator's (assertBindingFitsNode), and some of
 * it reads the report: an AmneziaWG 3.1 profile is refused on a node that has
 * not said it runs 3.1. Not reported in time is not fatal; such bindings are
 * skipped and named in the alert.
 */
export async function waitForCoresReport(nodeId: string, timeoutMs = 3 * 60 * 1000, stepMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.node.findUnique({ where: { id: nodeId }, select: { cores: true } });
    if (row?.cores != null) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export interface PoolDepsOptions {
  runner?: AnsibleRunner;
  waitForReport?: (nodeId: string) => Promise<boolean>;
  schedule?: (fn: () => void, ms: number) => void;
  notify?: (n: SwapNotice) => void;
  /** WARP registration of the spare (a Cloudflare call); injectable for tests. */
  registerWarp?: (nodeId: string) => Promise<unknown>;
}

/**
 * The DB-backed HotswapDeps.
 *
 * promote: the spare gets the cores of the node it replaces (and of every
 * binding it will take), the burned node's core-version intent if it has none
 * of its own, a bootstrap token, the install, and leaves `disabled` for
 * `unknown`, after which the status poller decides.
 *
 * repoint: the burned node's bindings, policy, resolver and WARP are carried.
 * Users need nothing else: the subscription selects `status: { not:
 * 'disabled' }`, so the moment retire flips the burned node it stops being
 * handed out, and the spare, now holding the bindings, starts.
 *
 * retire: `disabled` + `hardening.pool.burned`. The agent on it is told
 * `disabled` on its heartbeat and stays up, soft-paused.
 */
export function makeHotswapDeps(opts: PoolDepsOptions = {}): HotswapDeps {
  const runner = opts.runner ?? defaultAnsibleRunner;
  const waitForReport = opts.waitForReport ?? ((id: string) => waitForCoresReport(id));
  return {
    now: () => Date.now(),
    log: (m) => getLogger().info(`[node-pool] ${m}`),
    schedule:
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      }),
    notify: opts.notify ?? notifySwap,
    loadPool: async (burnedId) => ({ spares: await loadColdPool(), burned: await loadBurnedNode(burnedId) }),

    promote: async (spare, burnedId) => {
      const [spareRow, burnedRow, bindings] = await Promise.all([
        prisma.node.findUniqueOrThrow({
          where: { id: spare.id },
          select: { intendedEngines: true, protocol: true, singboxEngine: true, coreVersions: true, hardening: true },
        }),
        prisma.node.findUniqueOrThrow({
          where: { id: burnedId },
          select: { intendedEngines: true, protocol: true, singboxEngine: true, coreVersions: true },
        }),
        prisma.profileNodeBinding.findMany({
          where: { nodeId: burnedId, enabled: true },
          select: { profile: { select: { protocol: true, engine: true } } },
        }),
      ]);
      const engines = spareEngines(
        readIntendedEngines(spareRow),
        readIntendedEngines(burnedRow),
        bindings.map((b) => b.profile),
      );
      const ownVersions = readCoreVersions(spareRow.coreVersions);
      await prisma.node.update({
        where: { id: spare.id },
        data: {
          intendedEngines: engines,
          protocol: nodeProtocolOf(engines),
          singboxEngine: engines.includes('singbox'),
          // Before the token: redeeming it resolves the versions to install.
          ...(Object.keys(ownVersions).length === 0
            ? { coreVersions: readCoreVersions(burnedRow.coreVersions) as Prisma.InputJsonValue }
            : {}),
        },
      });

      const { token } = await issueBootstrapToken(spare.id);
      const hardening = (spareRow.hardening ?? {}) as { ufwLockdown?: boolean; fail2ban?: boolean; sshAllowlist?: string[] };
      const panelIp = await getPanelPublicIp();
      const { dryRun } = await runner.provision(
        { id: spare.id, name: spare.name },
        {
          iceslab_panel_url: config.PUBLIC_URL,
          iceslab_bootstrap_token: token,
          iceslab_engines: engines,
          ...(panelIp ? { iceslab_panel_ip: panelIp } : {}),
          ...(hardening.ufwLockdown ? { iceslab_harden_ufw: true as const } : {}),
          ...(hardening.fail2ban ? { iceslab_fail2ban: true as const } : {}),
          ...(hardening.sshAllowlist?.length ? { iceslab_ssh_allowlist: hardening.sshAllowlist } : {}),
        },
      );

      await prisma.node.update({
        where: { id: spare.id },
        data: { status: 'unknown', lastStatusChange: new Date() },
      });
      eventBus.emit('node.changed', { nodeId: spare.id });
      if (!dryRun && !(await waitForReport(spare.id))) {
        getLogger().warn(`[node-pool] promote ${spare.name}: no report of its cores yet, carrying anyway`);
      }
    },

    repoint: async (burnedId, spareId) => {
      const bindings = await carryBindings(burnedId, spareId);
      const notes = [...bindings.notes, ...(await carryNodeSettings(burnedId, spareId, opts.registerWarp))];
      return { carried: bindings.carried, total: bindings.total, notes };
    },

    retire: async (burnedId) => {
      const row = await prisma.node.findUniqueOrThrow({ where: { id: burnedId }, select: { hardening: true } });
      const hardening = {
        ...((row.hardening as object | null) ?? {}),
        pool: { ...poolLabels(row.hardening), burned: true },
      };
      await prisma.node.update({
        where: { id: burnedId },
        data: { status: 'disabled', lastStatusChange: new Date(), hardening },
      });
      eventBus.emit('node.changed', { nodeId: burnedId });
    },
  };
}

/**
 * Give the spare the inbounds the burned node was serving. A node only reaches
 * a subscription through a BINDING, and a cold spare has none: without this the
 * swap completes and every user comes back one node short.
 *
 * What carries is the profile, the port and the per-node overrides. What does
 * NOT is `publicHost` / `publicPort`: those name the machine being retired.
 * Left null, the subscription falls back to the spare's own address, which is
 * the point of swapping to it. Extra hosts of a binding stay behind as well;
 * the carried one gets its Default host from createBinding.
 *
 * Through the service, not a raw insert: createBinding runs the same gate as
 * the operator's form and creates the Default host the subscription iterates.
 * Per binding and best-effort: a spare that already serves that profile keeps
 * what it has, and one that refuses (port taken, a core it has not reported)
 * is noted rather than aborting a swap that has already promoted a node.
 */
async function carryBindings(burnedId: string, spareId: string): Promise<{ carried: number; total: number; notes: string[] }> {
  const [burnedBindings, spareBindings] = await Promise.all([
    prisma.profileNodeBinding.findMany({
      where: { nodeId: burnedId, enabled: true },
      select: { profileId: true, port: true, overrides: true, profile: { select: { name: true } } },
    }),
    prisma.profileNodeBinding.findMany({ where: { nodeId: spareId }, select: { profileId: true } }),
  ]);
  const served = new Set(spareBindings.map((b) => b.profileId));
  const notes: string[] = [];
  let carried = 0;
  for (const b of burnedBindings) {
    if (served.has(b.profileId)) continue;
    try {
      await createBinding({
        profileId: b.profileId,
        nodeId: spareId,
        port: b.port,
        overrides: (b.overrides ?? undefined) as Record<string, unknown> | undefined,
        enabled: true,
      });
      carried++;
    } catch (err) {
      notes.push(`profile "${b.profile.name}" not carried: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  getLogger().info(`[node-pool] repoint ${burnedId} → ${spareId}: carried ${carried}/${burnedBindings.length} binding(s)`);
  return { carried, total: burnedBindings.length, notes };
}

/**
 * The node-level settings that describe traffic rather than the machine: the
 * node policy, the resolver, WARP egress. The policy goes through updateNode,
 * so a policy the spare cannot carry out is refused exactly as on the node
 * page, and noted. WARP is registered anew: the account is a Cloudflare device,
 * one per machine, and is never copied. Cascades are not rewired: a hop is the
 * operator's design, and the alert says which cascades lost one.
 */
async function carryNodeSettings(
  burnedId: string,
  spareId: string,
  registerWarp: (nodeId: string) => Promise<unknown> = registerNodeWarp,
): Promise<string[]> {
  const notes: string[] = [];
  const burned = await prisma.node.findUniqueOrThrow({
    where: { id: burnedId },
    select: {
      policyId: true,
      dns: true,
      warpEnabled: true,
      cascadePositions: { select: { position: { select: { cascade: { select: { name: true } } } } } },
    },
  });

  const patch: { policyId?: string; dns?: Prisma.JsonValue } = {};
  if (burned.policyId) patch.policyId = burned.policyId;
  if (burned.dns != null) patch.dns = burned.dns;
  if (Object.keys(patch).length > 0) {
    try {
      await updateNode(spareId, patch as Parameters<typeof updateNode>[1]);
    } catch (err) {
      notes.push(`node policy / resolver not carried: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (burned.warpEnabled) {
    try {
      await registerWarp(spareId);
      // A registration writes the row and pushes nothing; the spare renders
      // the warp block on its next push, which this asks for.
      const spare = await prisma.node.findUniqueOrThrow({ where: { id: spareId }, select: { name: true } });
      eventBus.emit('node.updated', { nodeId: spareId, nodeName: spare.name });
    } catch (err) {
      notes.push(`WARP not registered on the spare: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cascades = [...new Set(burned.cascadePositions.map((p) => p.position.cascade.name))];
  if (cascades.length > 0) notes.push(`cascades not rewired (the burned node is a hop of ${cascades.join(', ')})`);
  return notes;
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
      eventBus.emit('node.replaced', {
        nodeId: n.burnedId,
        spareId: n.spareId,
        carried: n.report.carried,
        total: n.report.total,
        notes: n.report.notes,
      });
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
    getLogger().warn({ err }, '[node-pool] swap notice failed');
  });
}

let registered = false;

/**
 * Subscribe the hotswap controller to the anomaly sensor. No-op unless
 * NODE_POOL_HOTSWAP_ENABLED. Once per process: the bus has no `off`, and a
 * second subscription would put two controllers on every incident, each
 * picking a spare for the same burned node. Returns whether it subscribed.
 */
export function registerNodePoolHandlers(opts: PoolDepsOptions = {}): boolean {
  if (!config.NODE_POOL_HOTSWAP_ENABLED) return false;
  // After the flag, not before: a call made while the pool was off must not
  // use up the one subscription.
  if (registered) return false;
  registered = true;

  const controller = new HotswapController({ ...DEFAULT_HOTSWAP_CONFIG, enabled: true }, makeHotswapDeps(opts));
  eventBus.on('node.anomaly', (ev) => {
    const r = controller.onAnomaly(ev);
    getLogger().info(`[node-pool] node.anomaly ${ev.nodeId}: ${r}`);
  });
  eventBus.on('node.anomaly-cleared', ({ nodeId }) => controller.onCleared(nodeId));
  getLogger().info('[node-pool] hotswap registered');
  return true;
}
