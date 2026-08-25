import type { HostMetricsResponse } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/redis.js';
import { NodeTransport, NodeRequestError } from './nodes.transport.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/telegram-notify.js';
import { getLogger } from '../../lib/logger.js';
import { eventBus } from '../../lib/event-bus.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { NodeCoreRestarts, NodeEgressTune } from '@iceslab/shared';

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
      egressTune: true,
    },
  });

  if (nodes.length === 0) return { ok: 0, down: 0 };

  let ok = 0;
  let down = 0;

  await Promise.all(
    nodes.map(async (node) => {
      const result = await checkOne(node);
      // `degraded` counts with down on purpose: the agent answers, but a core
      // the operator configured is not serving anybody, and a summary that
      // called that "ok" is what let a dead cascade entry look healthy.
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
      const storedRestarts = (node.coreRestarts as NodeCoreRestarts | null) ?? null;
      const restartsChanged =
        result.coreRestarts !== undefined &&
        restartsWorthWriting(storedRestarts, result.coreRestarts, Date.now());
      // F3: write only when the STRATEGY moved, not on every poll. observedAt
      // changes every 30 seconds, so comparing the whole object would rewrite
      // the row forever; what an operator cares about is that the node changed
      // its mind about how to get through.
      const storedTune = (node.egressTune as NodeEgressTune | null) ?? null;
      const tuneChanged =
        result.egressTune !== undefined && tuneWorthWriting(storedTune, result.egressTune);
      if (statusChanged || messageChanged || versionChanged || restartsChanged || tuneChanged) {
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
            ...(tuneChanged
              ? { egressTune: result.egressTune as unknown as Prisma.InputJsonValue }
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
      // Tell the read caches that liveness moved. Deliberately NOT
      // node.changed: that one re-pushes config and would restart cores on
      // every flap. This only invalidates caches, which is what a subscription
      // filtered by liveness needs.
      if (statusChanged) {
        eventBus.emit('node.status-changed', {
          nodeId: node.id,
          from: node.status,
          to: result.status,
        });
      }
      // Re-push inbounds when a node comes back up. Without this, any
      // applyInbounds attempts that happened while the node was offline
      // (e.g. auto-deploy at node creation, or binding edits during a
      // network blip) get exhausted by BullMQ retries and never resume,
      // xray/etc would stay unconfigured even though the agent is alive.
      // Cheap: the node-agent dedupes identical pushes on its side.
      //
      // `degraded` counts as back up here, and that matters: a node whose core
      // will not start is exactly the one that needs the config again. Keying
      // this on `online` would have skipped the only nodes it was written for.
      if (statusChanged && result.status !== 'unreachable') {
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
        const icon =
          result.status === 'online' ? '✅' : result.status === 'degraded' ? '⚠️' : '🔴';
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
  /**
   * `online`     - the agent answers and every configured core is serving.
   * `degraded`   - the agent answers, a configured core is not running. Still
   *                served in subscriptions: its other endpoints work, and the
   *                liveness filter is keyed on `unreachable`, not on this.
   * `unreachable`- the panel could not reach the AGENT. Says nothing about the
   *                proxy ports, which fail independently.
   */
  status: 'online' | 'degraded' | 'unreachable';
  message: string | null;
  // T7: xray core version reported by this poll's /healthz, or undefined when
  // the node was unreachable / reported no xray core / runs a pre-T7 agent.
  // Undefined means "leave the stored coreVersion untouched".
  coreVersion?: string;
  // 2026-08-04: restart tally from the same /healthz. Undefined follows the
  // same rule as coreVersion - unreachable node or pre-2026-08 agent.
  coreRestarts?: NodeCoreRestarts;
  // F3: the self-tuned egress strategy this poll observed. Undefined follows
  // the same rule as the two above - unreachable node, pre-F3 agent, or a node
  // that does not self-tune. Undefined means "leave the stored one alone",
  // which matters because a node that stops reporting has not stopped running
  // the strategy it last found.
  egressTune?: NodeEgressTune;
}

/**
 * Heartbeat for `observedAt`: even when nothing changed, refresh the row this
 * often so the stamp keeps meaning "we polled this node recently".
 *
 * Added 2026-08-04 after the frontend pointed out the original hole: writes
 * only happened when a counter or RSS moved, so on a healthy node `observedAt`
 * froze for hours and the card could not tell "quiet and fine" from "nobody has
 * polled this node since lunch". One write per node per 10 minutes is nothing
 * next to being unable to trust the freshness stamp at all.
 *
 * Consumers: treat data older than roughly twice this as "not being refreshed".
 */
const RESTARTS_HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * Should this tally replace the stored one?
 *
 * The counters move rarely, but `rssBytes` moves on every 30s tick, and writing
 * a row per node per tick just to record memory jitter is pure WAL churn on a
 * fleet. So: write when anything meaningful changed, when RSS drifted more than
 * 10% (enough for the card to track the trend), or when the freshness stamp is
 * older than the heartbeat above.
 */
/**
 * Whether a reported tune differs from the stored one in a way worth a write.
 * Everything but observedAt: the same strategy re-reported on the next poll is
 * the normal case and must not touch the row.
 */
export function tuneWorthWriting(stored: NodeEgressTune | null, fresh: NodeEgressTune): boolean {
  if (!stored) return true;
  return (
    stored.args !== fresh.args ||
    stored.domain !== fresh.domain ||
    stored.protocol !== fresh.protocol ||
    stored.working !== fresh.working ||
    stored.total !== fresh.total
  );
}

function restartsWorthWriting(
  stored: NodeCoreRestarts | null,
  fresh: NodeCoreRestarts,
  nowMs: number,
): boolean {
  if (!stored) return true;
  if (
    stored.core !== fresh.core ||
    stored.total !== fresh.total ||
    stored.crash !== fresh.crash ||
    stored.memory !== fresh.memory ||
    stored.lastAt !== fresh.lastAt ||
    stored.lastReason !== fresh.lastReason ||
    stored.sinceAt !== fresh.sinceAt ||
    stored.memoryLimitBytes !== fresh.memoryLimitBytes
  ) {
    return true;
  }
  const storedAt = Date.parse(stored.observedAt);
  // NaN (missing/garbled stamp on a row written by an older build) counts as
  // stale, so the next poll repairs it instead of freezing forever.
  if (!Number.isFinite(storedAt) || nowMs - storedAt >= RESTARTS_HEARTBEAT_MS) {
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
    // Restart tally: prefer xray (the only core that arms the watchdog today),
    // but fall back to whichever core reported one. The agent contract allows
    // any subprocess-backed core to report, so hard-coding xray would leave the
    // field empty on a node whose other core started reporting.
    // ⚠ Single tally by design: when a second core actually arms a watchdog,
    // this becomes a list and `core` inside the object is what disambiguates.
    const restartCore = xrayCore?.restarts ? xrayCore : res.cores.find((c) => c.restarts);
    // 2026-08-04: restart tally, stamped with the observation time so the card
    // can show how fresh it is. `total` is recomputed rather than trusted, so a
    // malformed agent response can't produce a tally that contradicts itself.
    const raw = restartCore?.restarts;
    const coreRestarts: NodeCoreRestarts | undefined = raw
      ? {
          // `core` comes from the agent (which core these numbers are for);
          // fall back to the core's own name for agents built before that
          // field existed.
          core: raw.core || restartCore?.name || 'xray',
          total: raw.crash + raw.memory,
          crash: raw.crash,
          memory: raw.memory,
          lastAt: raw.lastAt,
          lastReason: raw.lastReason,
          sinceAt: raw.sinceAt,
          // Normalise 0 to absent. On the wire the agent means the same thing
          // by both ("no ceiling" / "not sampled"), and storing one of the two
          // spellings keeps consumers from having to check for each.
          memoryLimitBytes: raw.memoryLimitBytes || undefined,
          rssBytes: raw.rssBytes || undefined,
          observedAt: new Date().toISOString(),
        }
      : undefined;
    // F3: stamp the observation time the same way the restart tally does, so
    // the UI can tell a strategy found this morning from one found in June.
    const egressTune: NodeEgressTune | undefined = res.egressTune
      ? { ...res.egressTune, observedAt: new Date().toISOString() }
      : undefined;
    const verdict = statusFromHealth(res);
    return { ...verdict, coreVersion, coreRestarts, egressTune };
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

/**
 * What a reachable node's answer means. Pure, so the rule can be read and
 * tested without a transport.
 */
/** Node status messages are capped at this; the column holds no more. */
const STATUS_MESSAGE_LIMIT = 200;

/**
 * The "not running" message, built so that every down core is NAMED.
 *
 * The obvious version — join the `name (reason)` pairs and cut the result to
 * the limit — loses whole cores. Two down cores exceed it (each reason is up to
 * 163 characters by the agent's own cap), so the second one is cut mid-word and
 * its reason vanishes entirely. Watched on the composed string: xray's reason
 * survived and hysteria's stopped one clause before "no such file or
 * directory", which is the only part that says what to do.
 *
 * So the names come first and are never sacrificed — an operator who cannot see
 * that hysteria is down as well has been told something false-by-omission —
 * and what remains of the budget is split evenly between the reasons.
 *
 * Each reason is trimmed from the FRONT, matching what the agent does and for
 * the same reason: xray nests with " > " and Go wraps with ": ", so the root
 * cause is at the end. A leading ellipsis marks the cut, because a clipped line
 * that reads like a whole sentence is worse than an obvious stub.
 */
export function composeDownMessage(
  cores: { name: string; lastError?: string }[],
): string {
  const head = 'not running: ';
  const bare = `${head}${cores.map((c) => c.name).join(', ')}`;
  if (bare.length >= STATUS_MESSAGE_LIMIT) return bare.slice(0, STATUS_MESSAGE_LIMIT);

  const annotated = cores.filter((c) => c.lastError);
  if (annotated.length === 0) return bare;

  // ` (…)` costs 3 characters per annotated core on top of the bare list.
  const budget = STATUS_MESSAGE_LIMIT - bare.length - annotated.length * 3;
  const per = Math.floor(budget / annotated.length);
  // Below this a reason is a fragment that explains nothing while looking like
  // it might. Names alone are the more honest message.
  if (per < 24) return bare;

  return `${head}${cores
    .map((c) => {
      const reason = c.lastError;
      if (!reason) return c.name;
      if (reason.length <= per) return `${c.name} (${reason})`;
      // Strip any ellipsis the agent already added before adding our own.
      const tail = reason.replace(/^\.+/, '').slice(-(per - 3));
      return `${c.name} (...${tail})`;
    })
    .join(', ')}`;
}

export function statusFromHealth(res: {
  status: string;
  cores: { name: string; running: boolean; provisioned?: boolean; lastError?: string }[];
}): { status: 'online' | 'degraded'; message: string | null } {
  if (res.status === 'ok') {
    return { status: 'online', message: null };
  }
  {
    // node-agent reachable, but one of the protocol sub-cores isn't running.
    // A fresh node with no Profile+Binding yet reports its cores unprovisioned,
    // and those are idle by design rather than down - see the filter below.
    //
    // Name the cores that are down instead of dumping the raw payload. The dump
    // used to fit, then the restart tally (2026-08-04) landed inside the first
    // core's object and pushed everything informative past the 160-char cut: all
    // four nodes of the field fleet stored a message that ends mid-JSON, before
    // any core that is actually down. A truncated explanation is worse than a
    // short one, because it still looks like an explanation.
    // A core with `provisioned: false` was never configured, so it is idle by
    // design, not down. Absent means an agent older than the field: read as
    // configured, which is how this behaved before.
    // Name the core AND, when the agent tells us, why it is down. `not running:
    // xray` is true and useless: the reason sat in the node's journal, on a
    // machine the operator has to go find, and nothing tied the crash to the
    // profile they had just saved. Watched live - a listen port already taken
    // gave sixteen crashes and a message that stopped at the core's name.
    const downCores = res.cores.filter((c) => !c.running && c.provisioned !== false);
    // The node is reachable and its cores are not. Until 2026-08-15 this stayed
    // `online` and said so only in the message, so an operator's node list
    // showed a green card while the cascade entry behind it served nobody: the
    // core had been dead for hours and nothing in the panel said a word. A
    // status is what people read; it has to carry this.
    //
    // Still not `unreachable`: the subscription's liveness filter is keyed on
    // that word, and a core being down is not a reason to pull the node's other
    // endpoints out of every subscriber's client.
    return {
      status: 'degraded',
      message: downCores.length
        ? composeDownMessage(downCores)
        : // No core reports itself down, yet the agent called the node degraded.
          // Keep the payload here: this is the case where the detail is not
          // something we can name in advance.
          `degraded: ${JSON.stringify(res).slice(0, 160)}`,
    };
  }
}
