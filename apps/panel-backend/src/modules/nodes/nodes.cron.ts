import type { HostMetricsResponse } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/redis.js';
import { NodeTransport, NodeRequestError } from './nodes.transport.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/telegram-notify.js';
import { getLogger } from '../../lib/logger.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CoreRestartsDto } from './nodes.mapper.js';

const METRICS_KEY_PREFIX = 'node:metrics:';
const METRICS_TTL_SECONDS = 60;

export function nodeMetricsKey(nodeId: string): string {
  return `${METRICS_KEY_PREFIX}${nodeId}`;
}

export async function readCachedNodeMetrics(
  nodeId: string,
): Promise<HostMetricsResponse | null> {
  const raw = await redis.get(nodeMetricsKey(nodeId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostMetricsResponse;
  } catch {
    return null;
  }
}

/**
 * Poll every active node's `/healthz` over mTLS and update `nodes.status`
 * + `lastStatusChange` + `lastStatusMessage`. Runs on a 30-second cron tick.
 *
 * Status mapping:
 *   - HTTP 200 + body.status === "ok"        → "online"
 *   - HTTP 200 + body.status === "degraded"  → "unreachable" (subprocess down etc.)
 *   - any error / timeout                    → "unreachable"
 *
 * `disabled` is admin-managed and never overwritten here. Soft-deleted nodes
 * are excluded by the same `deletedAt: null` filter we use for fan-out.
 *
 * Slice 23.1, added after VPS test 2026-05-06, where the panel never lifted
 * a freshly-installed node out of `unknown` because no poller existed.
 */
export async function pollNodeStatuses(): Promise<{ ok: number; down: number }> {
  const nodes = await prisma.node.findMany({
    where: { deletedAt: null, status: { not: 'disabled' } },
    select: {
      id: true,
      name: true,
      address: true,
      status: true,
      lastStatusMessage: true,
      coreVersion: true,
      coreRestarts: true,
    },
  });

  if (nodes.length === 0) return { ok: 0, down: 0 };

  let ok = 0;
  let down = 0;

  await Promise.all(
    nodes.map(async (node) => {
      const result = await checkOne(node);
      if (result.status === 'online') ok++;
      else down++;
      // Write to DB when status OR message changed since last tick. We also
      // compare lastStatusMessage so that a "degraded → ok" transition
      // actually clears the old degraded blurb from the UI. Pre-wave-13 the
      // guard was `statusChanged || result.message`, which never re-wrote
      // when the new message was null, leaving stale `degraded: {...}` in
      // the row forever after the underlying subprocess came back.
      const statusChanged = result.status !== node.status;
      const messageChanged = result.message !== node.lastStatusMessage;
      // T7: only touch coreVersion when this poll actually observed one (a
      // reachable agent that reported an xray core). Undefined = keep stored.
      const versionChanged =
        result.coreVersion !== undefined && result.coreVersion !== node.coreVersion;
      // Same rule for the restart tally: undefined = the node was unreachable
      // or runs a pre-2026-08 agent, so keep whatever is stored.
      const storedRestarts = (node.coreRestarts as CoreRestartsDto | null) ?? null;
      const restartsChanged =
        result.coreRestarts !== undefined &&
        restartsWorthWriting(storedRestarts, result.coreRestarts);
      if (statusChanged || messageChanged || versionChanged || restartsChanged) {
        await prisma.node.update({
          where: { id: node.id },
          data: {
            status: result.status,
            lastStatusChange: statusChanged ? new Date() : undefined,
            lastStatusMessage: result.message,
            ...(versionChanged ? { coreVersion: result.coreVersion } : {}),
            // Cast mirrors the jsonb-write pattern used for `hardening` in
            // nodes.service.ts: a typed interface has no index signature, so it
            // needs the explicit widening to InputJsonValue.
            ...(restartsChanged
              ? { coreRestarts: result.coreRestarts as unknown as Prisma.InputJsonValue }
              : {}),
          },
        });
      }
      // Alert on a core that restarted since the previous tick. This is the
      // whole reason the counter exists: a memory-ceiling restart drops live
      // connections, and without a notification it looks like nothing happened
      // (the node stays online, so the status alert below never fires).
      // Only on growth - a smaller total means the AGENT restarted and lost its
      // in-memory tally, which is not a core restart.
      if (result.coreRestarts && storedRestarts && result.coreRestarts.total > storedRestarts.total) {
        const delta = result.coreRestarts.total - storedRestarts.total;
        const reason = result.coreRestarts.lastReason === 'memory' ? 'memory ceiling' : 'crash';
        notifyTelegramAsync(
          `♻️ *Core restarted*\nnode: \`${escapeMarkdown(node.name)}\`\n` +
            `reason: ${escapeMarkdown(reason)}\ncount: +${delta} (total ${result.coreRestarts.total})`,
        );
      }
      // Re-push inbounds when a node comes back up. Without this, any
      // applyInbounds attempts that happened while the node was offline
      // (e.g. auto-deploy at node creation, or binding edits during a
      // network blip) get exhausted by BullMQ retries and never resume,
      // xray/etc would stay unconfigured even though the agent is alive.
      // Cheap: the node-agent dedupes identical pushes on its side.
      if (statusChanged && result.status === 'online') {
        void inboundSyncQueue
          .add(
            'applyNodeInbounds',
            { nodeId: node.id },
            { jobId: `apply-${node.id}` },
          )
          .catch((err: unknown) => {
            getLogger().error({ err }, `[cron] re-enqueue applyInbounds for ${node.name} failed`);
          });
      }
      // Slice 32: admin alerts on node status flips. Skip the initial
      // `unknown → online` transition (new node coming up isn't an alert
      // event) but alert on every later flip in either direction. The
      // notifyTelegramAsync helper is a no-op when env isn't configured,
      // so this stays free for operators who don't use Telegram.
      if (statusChanged && node.status !== 'unknown') {
        const icon = result.status === 'online' ? '✅' : '🔴';
        notifyTelegramAsync(
          `${icon} *Node ${result.status}*\nname: \`${escapeMarkdown(node.name)}\`\naddress: \`${escapeMarkdown(node.address)}\`` +
            (result.message ? `\nlast: ${escapeMarkdown(result.message)}` : ''),
        );
      }
    }),
  );

  return { ok, down };
}

interface PollResult {
  status: 'online' | 'unreachable';
  message: string | null;
  // T7: xray core version reported by this poll's /healthz, or undefined when
  // the node was unreachable / reported no xray core / runs a pre-T7 agent.
  // Undefined means "leave the stored coreVersion untouched".
  coreVersion?: string;
  // 2026-08-04: restart tally from the same /healthz. Undefined follows the
  // same rule as coreVersion - unreachable node or pre-2026-08 agent.
  coreRestarts?: CoreRestartsDto;
}

/**
 * Should this tally replace the stored one?
 *
 * The counters move rarely, but `rssBytes` moves on every 30s tick, and writing
 * a row per node per tick just to record memory jitter is pure WAL churn on a
 * fleet. So: always write when anything meaningful changed, and otherwise only
 * when RSS drifted more than 10% from what is stored (enough for the card to
 * track the trend without a write every half-minute).
 */
function restartsWorthWriting(
  stored: CoreRestartsDto | null,
  fresh: CoreRestartsDto,
): boolean {
  if (!stored) return true;
  if (
    stored.total !== fresh.total ||
    stored.crash !== fresh.crash ||
    stored.memory !== fresh.memory ||
    stored.lastAt !== fresh.lastAt ||
    stored.lastReason !== fresh.lastReason ||
    stored.memoryLimitBytes !== fresh.memoryLimitBytes
  ) {
    return true;
  }
  const prevRss = stored.rssBytes ?? 0;
  const nextRss = fresh.rssBytes ?? 0;
  if (prevRss === 0) return nextRss !== 0;
  return Math.abs(nextRss - prevRss) / prevRss > 0.1;
}

/**
 * Pull /metrics from every online node in parallel and cache in Redis with
 * TTL 60s. Per-node failures are swallowed (we just won't have fresh metrics
 * for that node, the dashboard will show the previous sample until TTL or
 * "-" if it's the first run).
 *
 * Runs on a 15-second tick. Disabled / unreachable nodes are skipped, no
 * point hammering them.
 */
export async function pollNodeMetrics(): Promise<{ ok: number; failed: number }> {
  const nodes = await prisma.node.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['disabled', 'unreachable'] },
    },
    select: { id: true, address: true },
  });
  if (nodes.length === 0) return { ok: 0, failed: 0 };

  let ok = 0;
  let failed = 0;
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const transport = new NodeTransport(node);
        const m = await transport.getMetrics();
        await redis.set(
          nodeMetricsKey(node.id),
          JSON.stringify(m),
          'EX',
          METRICS_TTL_SECONDS,
        );
        ok++;
      } catch {
        failed++;
      }
    }),
  );
  return { ok, failed };
}

async function checkOne(node: {
  id: string;
  name: string;
  address: string;
}): Promise<PollResult> {
  try {
    const transport = new NodeTransport(node);
    const res = await transport.healthcheck();
    // T7: capture the xray core version if the agent reported one (pre-T7
    // agents and non-xray nodes omit it, leaving coreVersion undefined).
    const xrayCore = res.cores.find((c) => c.name === 'xray');
    const coreVersion = xrayCore?.version || undefined;
    // 2026-08-04: restart tally, stamped with the observation time so the card
    // can show how fresh it is. `total` is recomputed rather than trusted, so a
    // malformed agent response can't produce a tally that contradicts itself.
    const raw = xrayCore?.restarts;
    const coreRestarts: CoreRestartsDto | undefined = raw
      ? {
          total: raw.crash + raw.memory,
          crash: raw.crash,
          memory: raw.memory,
          lastAt: raw.lastAt,
          lastReason: raw.lastReason,
          memoryLimitBytes: raw.memoryLimitBytes,
          rssBytes: raw.rssBytes,
          observedAt: new Date().toISOString(),
        }
      : undefined;
    if (res.status === 'ok') {
      return { status: 'online', message: null, coreVersion, coreRestarts };
    }
    // node-agent reachable + healthy, but one of the protocol sub-cores
    // isn't running. Normal for a fresh node with no Profile+Binding yet
    // (xray/ss/etc have no config → not started). Keep status online,
    // surface detail in lastStatusMessage; it auto-clears once a binding
    // lands and the core boots.
    return {
      status: 'online',
      message: `degraded: ${JSON.stringify(res).slice(0, 160)}`,
      coreVersion,
      coreRestarts,
    };
  } catch (err) {
    if (err instanceof NodeRequestError) {
      return { status: 'unreachable', message: `${err.status} ${err.message}`.slice(0, 200) };
    }
    return {
      status: 'unreachable',
      message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}
