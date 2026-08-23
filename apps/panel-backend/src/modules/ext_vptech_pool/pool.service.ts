import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Prisma } from '../../generated/prisma/client.js';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/event-bus.js';
import { getLogger } from '../../lib/logger.js';
import { issueBootstrapToken } from '../nodes/bootstrap.service.js';
import { HotswapController } from './pool.hotswap.js';
import {
  DEFAULT_HOTSWAP_CONFIG,
  type BurnedNode,
  type HotswapDeps,
  type SpareNode,
} from './pool.types.js';

// F2 — DB-backed wiring for the cold-pool hotswap (the pure policy lives in
// pool.policy.ts / pool.hotswap.ts). Off-by-default: registerPoolEventHandlers
// is a no-op unless EXT_VPTECH_POOL_ENABLED.

interface PoolLabels {
  asn?: string;
  provider?: string;
  burned?: boolean;
}

function poolLabels(hardening: unknown): PoolLabels {
  const h = hardening as { pool?: PoolLabels } | null | undefined;
  return h?.pool ?? {};
}

/**
 * The cold pool: nodes that are `disabled` and have NEVER redeemed a bootstrap
 * token (no agent ever came up → the IP is unexposed), excluding ones already
 * `burned`. Maps the F2 diversity labels (asn/provider from hardening.pool,
 * country + cost from the node row).
 */
export async function loadColdPool(): Promise<SpareNode[]> {
  const rows = await prisma.node.findMany({
    where: {
      deletedAt: null,
      status: 'disabled',
      bootstrapTokens: { none: { consumedAt: { not: null } } },
    },
    select: {
      id: true,
      name: true,
      countryCode: true,
      consumptionMultiplier: true,
      hardening: true,
    },
  });
  const spares: SpareNode[] = [];
  for (const r of rows) {
    const labels = poolLabels(r.hardening);
    if (labels.burned) continue; // a retired IP must never be re-promoted
    spares.push({
      id: r.id,
      name: r.name,
      asn: labels.asn ?? null,
      provider: labels.provider ?? null,
      countryCode: r.countryCode ?? null,
      consumptionMultiplier: Number(r.consumptionMultiplier),
    });
  }
  return spares;
}

/** Load the burned node's diversity labels for spare selection. */
export async function loadBurnedNode(nodeId: string): Promise<BurnedNode | null> {
  const r = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { id: true, countryCode: true, hardening: true },
  });
  if (!r) return null;
  const labels = poolLabels(r.hardening);
  return {
    id: r.id,
    asn: labels.asn ?? null,
    provider: labels.provider ?? null,
    countryCode: r.countryCode ?? null,
  };
}

/**
 * Provisions a freshly-promoted spare. The default impl runs the U6 ansible
 * playbook (deploy/ansible/site.yml) limited to the spare, passing the
 * bootstrap token — but ONLY when EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK is set;
 * otherwise it logs a dry-run, so the swap wiring can be exercised without a
 * live ansible control node. Injectable so tests pass a mock.
 */
export interface AnsibleRunner {
  provision(spare: SpareNode, bootstrapToken: string): Promise<void>;
}

const execFileAsync = promisify(execFile);

export const defaultAnsibleRunner: AnsibleRunner = {
  async provision(spare, bootstrapToken) {
    const playbook = config.EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK;
    if (!playbook) {
      getLogger().warn(
        `[pool] promote ${spare.name}: EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK unset — dry-run, NOT provisioning ` +
          `(token ${bootstrapToken.slice(0, 8)}… would provision ${spare.id})`,
      );
      return;
    }
    // Run the U6 playbook limited to this spare, passing the bootstrap token +
    // panel URL the agent task needs. CI never hits this (the flag is unset);
    // the control node (panel host) must have ansible + SSH/inventory reach.
    const args = [
      playbook,
      '--limit',
      spare.name,
      '-e',
      `iceslab_bootstrap_token=${bootstrapToken}`,
      '-e',
      `iceslab_panel_url=${config.PUBLIC_URL}`,
    ];
    if (config.EXT_VPTECH_POOL_ANSIBLE_INVENTORY) {
      args.splice(1, 0, '-i', config.EXT_VPTECH_POOL_ANSIBLE_INVENTORY);
    }
    getLogger().info(`[pool] promote ${spare.name}: running ${config.EXT_VPTECH_POOL_ANSIBLE_BIN} ${args.join(' ')}`);
    const { stdout } = await execFileAsync(config.EXT_VPTECH_POOL_ANSIBLE_BIN, args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ANSIBLE_HOST_KEY_CHECKING: 'False' },
    });
    getLogger().info(`[pool] promote ${spare.name}: ansible done — ${stdout.trim().split('\n').slice(-1)[0]}`);
  },
};

/**
 * Build the HotswapDeps backed by the DB + ansible runner. promote: mint a
 * bootstrap token → provision via ansible → flip the spare to active (and
 * re-push its inbounds via node.updated). retire: flip the burned node to
 * disabled + mark its IP burned.
 *
 * repoint is a deliberate no-op, and what makes that safe is the subscription
 * query itself: it selects `status: { not: 'disabled' }`, so the moment retire
 * flips the burned node it stops being handed out, and the promoted spare
 * starts. Nothing has to move users explicitly. (Entry ORDER then settles on
 * its own — rendezvous ranking rehashes only the subscribers who were on the
 * node that left.) Verified against that query rather than assumed: if the
 * exclusion ever moves, this whole step silently stops retiring anything.
 */
export function makeHotswapDeps(runner: AnsibleRunner = defaultAnsibleRunner): HotswapDeps {
  return {
    now: () => Date.now(),
    log: (m) => getLogger().info(`[pool] ${m}`),
    promote: async (spare) => {
      const { token } = await issueBootstrapToken(spare.id);
      await runner.provision(spare, token);
      await prisma.node.update({ where: { id: spare.id }, data: { status: 'active' } });
      eventBus.emit('node.updated', { nodeId: spare.id, nodeName: spare.name });
    },
    repoint: async (burnedId, spareId) => {
      getLogger().info(
        `[pool] repoint ${burnedId} → ${spareId}: users are carried by the status flip — the burned node drops out of /sub and the spare appears on the next fetch`,
      );
      await carryEgressPolicy(burnedId, spareId);
    },
    retire: async (burnedId) => {
      const row = await prisma.node.findUnique({
        where: { id: burnedId },
        select: { hardening: true },
      });
      const hardening = {
        ...((row?.hardening as object | null) ?? {}),
        pool: { ...poolLabels(row?.hardening), burned: true },
      };
      await prisma.node.update({
        where: { id: burnedId },
        data: { status: 'disabled', hardening },
      });
    },
  };
}

/**
 * Move the burned node's egress policy onto the spare, so a hotswap does not
 * quietly undo an operator's split.
 *
 * The POLICY carries and the CHANNELS do not, and that asymmetry is the model
 * rather than a shortcut: a policy says which flows leave by which way out,
 * which is a statement about traffic and true wherever it runs, while a channel
 * (the zapret2 desync proxy, a WARP registration) is a property of one machine
 * that has to be provisioned on it. Copying a channel would claim something the
 * spare does not run. Copying the policy is safe by construction, because the
 * compiler drops any rule naming a way out that node has not got - the split
 * comes back to whatever the spare can actually serve, and the rest is logged.
 *
 * Merged into the spare's own hardening rather than replacing it: the spare has
 * pool labels of its own, and possibly a channel it was provisioned with.
 */
async function carryEgressPolicy(burnedId: string, spareId: string): Promise<void> {
  const [burned, spare] = await Promise.all([
    prisma.node.findUnique({ where: { id: burnedId }, select: { hardening: true } }),
    prisma.node.findUnique({ where: { id: spareId }, select: { name: true, hardening: true } }),
  ]);
  const burnedHardening = burned?.hardening as
    | { egressPolicy?: unknown; zapret2?: unknown }
    | null;
  if (burnedHardening?.egressPolicy == null) return;

  // A channel the burned node ran is worth saying out loud: the spare keeps the
  // rules that name it only if it was provisioned with one too, and an operator
  // reading "hotswap done" should not have to discover that by traffic.
  if (burnedHardening.zapret2 != null) {
    getLogger().info(
      `[pool] repoint ${burnedId} → ${spareId}: the burned node ran a zapret2 channel; the spare keeps the policy but only serves rules for channels IT runs`,
    );
  }

  const merged = {
    ...((spare?.hardening as object | null) ?? {}),
    egressPolicy: burnedHardening.egressPolicy,
  };
  await prisma.node.update({
    where: { id: spareId },
    data: { hardening: merged as Prisma.InputJsonValue },
  });
  // promote() already emitted for the spare, but that was BEFORE the policy
  // landed on it; without a second push the spare serves the old config until
  // something unrelated moves.
  eventBus.emit('node.updated', { nodeId: spareId, nodeName: spare?.name ?? spareId });
  getLogger().info(`[pool] repoint ${burnedId} → ${spareId}: egress policy carried over`);
}

/**
 * Subscribe the hotswap controller to node.anomaly. No-op unless
 * EXT_VPTECH_POOL_ENABLED. The controller instance persists (debounce state).
 */
export function registerPoolEventHandlers(runner: AnsibleRunner = defaultAnsibleRunner): void {
  if (!config.EXT_VPTECH_POOL_ENABLED) return;

  const controller = new HotswapController(
    { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
    makeHotswapDeps(runner),
  );

  eventBus.on('node.anomaly', (ev) => {
    void (async () => {
      try {
        const burned = await loadBurnedNode(ev.nodeId);
        if (!burned) return;
        const spares = await loadColdPool();
        const res = await controller.onAnomaly(ev, spares, burned);
        getLogger().info(
          `[pool] node.anomaly ${ev.nodeId} → ${res.reason}${res.spareId ? ` spare=${res.spareId}` : ''}`,
        );
      } catch (err) {
        getLogger().warn(
          `[pool] hotswap handler failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  });

  getLogger().info('[pool] hotswap handler registered (EXT_VPTECH_POOL_ENABLED)');
}
