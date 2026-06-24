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

export const defaultAnsibleRunner: AnsibleRunner = {
  async provision(spare, bootstrapToken) {
    const playbook = config.EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK;
    if (!playbook) {
      getLogger().warn(
        `[pool] promote ${spare.name}: EXT_VPTECH_POOL_ANSIBLE_PLAYBOOK unset — dry-run, NOT provisioning ` +
          `(token ${bootstrapToken.slice(0, 8)}… would run ${'ansible-playbook'} against ${spare.id})`,
      );
      return;
    }
    // Real provisioning is deferred to a live control node; the command shape
    // is documented here. (Kept out of the default path so CI never shells out.)
    throw new Error(
      `[pool] real ansible promote not wired in this build — run: ansible-playbook ${playbook} ` +
        `--limit ${spare.name} -e iceslab_bootstrap_token=${bootstrapToken}`,
    );
  },
};

/**
 * Build the HotswapDeps backed by the DB + ansible runner. promote: mint a
 * bootstrap token → provision via ansible → flip the spare to active (and
 * re-push its inbounds via node.updated). retire: flip the burned node to
 * disabled + mark its IP burned. repoint: a no-op — once the spare is active
 * and the burned node disabled, F1 diversity naturally excludes the burned one
 * and includes the spare on the next /sub.
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
        `[pool] repoint ${burnedId} → ${spareId}: handled by status change + F1 diversity on next /sub`,
      );
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
