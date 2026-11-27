import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EngineName } from '@iceslab/shared';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { getLogger } from '../../lib/infra/logger.js';
import { escapeMarkdown, notifyTelegramAsync } from '../../lib/notify/telegram-notify.js';
import { issueBootstrapToken } from '../nodes/bootstrap.service.js';
import { updateNode } from '../nodes/nodes.service.js';
import type { UpdateNodeInput } from '../nodes/nodes.schemas.js';
import { createBinding } from '../profiles/profiles.service.js';
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
 * Installs a promoted spare. Injectable: tests pass a mock; the default runs
 * the ansible role from the panel (`defaultAnsibleRunner`).
 */
export interface AnsibleRunner {
  provision(spare: { id: string; name: string }, vars: ProvisionVars): Promise<void>;
}

export interface AnsibleRunnerSettings {
  playbook: string;
  inventory: string;
  bin: string;
}

type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr?: string }>;

const execFileAsync = promisify(execFile) as unknown as ExecFileFn;

/**
 * Longer than that and the token is near its end (15 minutes, TOKEN_TTL_MS in
 * bootstrap.service.ts): a slower install would fail on the token anyway.
 */
export const PROVISION_TIMEOUT_MS = 10 * 60 * 1000;

// `--limit` takes a host PATTERN, not a name: `all`, `a:b`, `web*` or a group
// would reach hosts other than the spare, with the spare's token. Only a plain
// host name goes through.
const LIMIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIMIT_RESERVED = new Set(['all', 'ungrouped']);

/**
 * The runner that runs the role `iceslab_node` (deploy/ansible) on the spare.
 *
 * No playbook configured: one log line, nothing runs, the swap goes on.
 *
 * Otherwise `ansible-playbook <playbook> [-i <inventory>] --limit <name> -e
 * @<vars file>`. The token and the panel address go in a 0600 file in a 0700
 * directory of their own, removed whatever happens: on argv the token would sit
 * in the process list of the panel host for the whole install. Only values that
 * are set go in: extra vars outrank the inventory, and an empty list here would
 * wipe the operator's `iceslab_engines`.
 *
 * Neither the file's content nor the token is logged. What the process says on
 * failure (stderr, the command line) goes through `redact` first.
 */
export function createAnsibleRunner(
  exec: ExecFileFn = execFileAsync,
  settings: () => AnsibleRunnerSettings = () => ({
    playbook: config.EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK,
    inventory: config.EXT_VPTECH_POOL_ANSIBLE_INVENTORY,
    bin: config.EXT_VPTECH_POOL_ANSIBLE_BIN,
  }),
): AnsibleRunner {
  return {
    async provision(spare, vars) {
      const { playbook, inventory, bin } = settings();
      const log = getLogger();
      if (!playbook) {
        log.warn(
          `[ext-vptech-pool] promote ${spare.name}: EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK is not set, nothing installed (engines ${vars.iceslab_engines.join(',') || 'none'}); run deploy/ansible against this node by hand`,
        );
        return;
      }
      if (!LIMIT_NAME.test(spare.name) || LIMIT_RESERVED.has(spare.name)) {
        throw new Error(
          `node name "${spare.name}" cannot be an ansible host name (letters, digits, dot, dash and underscore only); rename the node and the inventory host`,
        );
      }

      const redact = (text: string): string => text.split(vars.iceslab_bootstrap_token).join('<token>');
      const dir = await mkdtemp(join(tmpdir(), 'ext-vptech-pool-'));
      try {
        const varsFile = join(dir, 'vars.json');
        const body: Record<string, unknown> = {
          iceslab_panel_url: vars.iceslab_panel_url,
          iceslab_bootstrap_token: vars.iceslab_bootstrap_token,
        };
        if (vars.iceslab_engines.length > 0) body.iceslab_engines = vars.iceslab_engines;
        await writeFile(varsFile, JSON.stringify(body), { mode: 0o600 });

        const args = [playbook];
        if (inventory) args.push('-i', inventory);
        args.push('--limit', spare.name, '-e', `@${varsFile}`);
        log.info(`[ext-vptech-pool] promote ${spare.name}: ${bin} ${args.join(' ')}`);
        let stdout: string;
        try {
          ({ stdout } = await exec(bin, args, {
            timeout: PROVISION_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            // ansible.cfg of the role sits next to the playbook and is read from the cwd only.
            cwd: dirname(resolve(playbook)),
            env: { ...process.env, ANSIBLE_HOST_KEY_CHECKING: 'False' },
          }));
        } catch (err) {
          const e = err as { killed?: boolean; signal?: string; stderr?: string };
          const why = e.killed ? `timed out after ${PROVISION_TIMEOUT_MS / 1000}s` : 'failed';
          const tail = redact(String(e.stderr ?? '').trim().split('\n').slice(-3).join(' | '));
          const first = redact(errText(err)).split('\n')[0];
          // No `cause`: the original error carries the process's stderr, which may hold the token.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(`${bin} ${why} on ${spare.name}: ${first}${tail ? ` (${tail})` : ''}`);
        }
        log.info(
          `[ext-vptech-pool] promote ${spare.name}: ansible done, ${redact(stdout.trim().split('\n').slice(-1)[0] ?? '')}`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export const defaultAnsibleRunner: AnsibleRunner = createAnsibleRunner();

export interface PoolDepsOptions {
  runner?: AnsibleRunner;
  schedule?: (fn: () => void, ms: number) => void;
  notify?: (n: SwapNotice) => void;
  /** What carries the burned node's settings onto the spare. Default: carryToSpare. */
  repoint?: HotswapDeps['repoint'];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Put the burned node's enabled bindings on the spare: same profile, port and
 * overrides. NOT the `publicHost` / `publicPort`: those name the machine that
 * is being retired, and left empty the subscription falls back to the spare's
 * own address, which is the point of swapping to it. Extra hosts stay behind;
 * the carried binding gets its Default host from createBinding.
 *
 * Through createBinding, not a raw insert: it runs the operator's gate (port
 * and transport, the node's cores and engines) and publishes `binding.created`,
 * which busts the /sub cache and queues the spare for a config push.
 *
 * Per binding and best-effort: a profile the spare already serves is left as it
 * is (so a second swap makes no duplicates), and one createBinding refuses is
 * noted and skipped, not allowed to abort a swap that has already promoted a node.
 */
export async function carryBindings(burnedId: string, spareId: string): Promise<CarryReport> {
  const [burnedBindings, spareBindings] = await Promise.all([
    prisma.profileNodeBinding.findMany({
      where: { nodeId: burnedId, enabled: true },
      orderBy: [{ port: 'asc' }, { createdAt: 'asc' }],
      select: { profileId: true, port: true, overrides: true, profile: { select: { name: true } } },
    }),
    prisma.profileNodeBinding.findMany({ where: { nodeId: spareId }, select: { profileId: true } }),
  ]);
  const served = new Set(spareBindings.map((b) => b.profileId));
  const notes: string[] = [];
  let carried = 0;
  for (const b of burnedBindings) {
    if (served.has(b.profileId)) {
      notes.push(`profile "${b.profile.name}" already served by the spare, kept as is`);
      continue;
    }
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
      notes.push(`profile "${b.profile.name}" (port ${b.port}) not carried: ${errText(err)}`);
    }
  }
  getLogger().info(
    `[ext-vptech-pool] repoint ${burnedId} -> ${spareId}: carried ${carried}/${burnedBindings.length} binding(s)`,
  );
  return { carried, total: burnedBindings.length, notes };
}

/**
 * The node policy and the resolver. The burned node's policy REPLACES the
 * spare's (the spare must behave as the burned node did); what it replaced goes
 * to the log. `dns` only fills a gap: a spare with its own resolver keeps it.
 * Both go through updateNode, so a policy the spare cannot carry out is refused
 * as on the node page, and the push and `policy.changed` / `node.updated` follow.
 * WARP, the pool labels, the multiplier and the public address stay the spare's.
 */
export async function carryNodeSettings(burnedId: string, spareId: string): Promise<string[]> {
  const notes: string[] = [];
  const [burned, spare] = await Promise.all([
    prisma.node.findUniqueOrThrow({ where: { id: burnedId }, select: { policyId: true, dns: true } }),
    prisma.node.findUniqueOrThrow({ where: { id: spareId }, select: { policyId: true, dns: true } }),
  ]);
  const log = getLogger();

  if (burned.policyId && burned.policyId !== spare.policyId) {
    try {
      await updateNode(spareId, { policyId: burned.policyId });
      log.info(
        `[ext-vptech-pool] repoint ${burnedId} -> ${spareId}: node policy ${burned.policyId} carried (the spare's previous: ${spare.policyId ?? 'none'})`,
      );
    } catch (err) {
      notes.push(`node policy not carried: ${errText(err)}`);
    }
  }

  if (burned.dns != null && spare.dns == null) {
    try {
      await updateNode(spareId, { dns: burned.dns } as UpdateNodeInput);
      log.info(`[ext-vptech-pool] repoint ${burnedId} -> ${spareId}: resolver carried`);
    } catch (err) {
      notes.push(`node resolver not carried: ${errText(err)}`);
    }
  }
  return notes;
}

/**
 * The names of the enabled-or-not cascades the node is a hop of: an entry or a
 * transit position, a direction's exit pool, or a hop of a pre-v4 chain.
 * Sorted and without repeats, so a node that is two hops of one cascade names
 * it once.
 */
export async function cascadesThroughNode(nodeId: string): Promise<string[]> {
  const [positions, directions, hops] = await Promise.all([
    prisma.cascadePositionNode.findMany({
      where: { nodeId },
      select: { position: { select: { cascade: { select: { name: true } } } } },
    }),
    prisma.cascadeDirectionNode.findMany({
      where: { nodeId },
      select: { direction: { select: { cascade: { select: { name: true } } } } },
    }),
    prisma.cascadeHop.findMany({ where: { nodeId }, select: { cascade: { select: { name: true } } } }),
  ]);
  const names = new Set([
    ...positions.map((p) => p.position.cascade.name),
    ...directions.map((d) => d.direction.cascade.name),
    ...hops.map((h) => h.cascade.name),
  ]);
  return [...names].sort();
}

/**
 * Cascades are not rewired: a hop is the operator's design, and the replacement
 * only NAMES the ones that lost a hop - in the journal and, as a note on the
 * report, in the notification - so the operator rebuilds them.
 */
async function noteCascades(burnedId: string, spareId: string): Promise<string[]> {
  const cascades = await cascadesThroughNode(burnedId);
  if (cascades.length === 0) return [];
  getLogger().warn(
    `[ext-vptech-pool] repoint ${burnedId} -> ${spareId}: cascades not rewired, the burned node is a hop of ${cascades.join(', ')}`,
  );
  return [`cascades not rewired (the burned node is a hop of ${cascades.join(', ')})`];
}

/** The repoint step: bindings first, then the node's own settings, then the cascades to name. */
export async function carryToSpare(burnedId: string, spareId: string): Promise<CarryReport> {
  const report = await carryBindings(burnedId, spareId);
  let settingsNotes: string[];
  try {
    settingsNotes = await carryNodeSettings(burnedId, spareId);
  } catch (err) {
    settingsNotes = [`node settings not carried: ${errText(err)}`];
  }
  let cascadeNotes: string[];
  try {
    cascadeNotes = await noteCascades(burnedId, spareId);
  } catch (err) {
    cascadeNotes = [`cascades through the burned node not listed: ${errText(err)}`];
  }
  return { ...report, notes: [...report.notes, ...settingsNotes, ...cascadeNotes] };
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
  const runner = opts.runner ?? defaultAnsibleRunner;
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

    repoint: opts.repoint ?? carryToSpare,

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
