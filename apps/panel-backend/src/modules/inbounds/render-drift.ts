import { createHash } from 'node:crypto';
import type { ApplyInboundsRequest } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/infra/redis.js';
import { getLogger } from '../../lib/infra/logger.js';

/**
 * What the panel draws for a node, compared with what it last delivered.
 *
 * A push goes out on an edit (an event bumps the node's revision) and on an
 * agent restart (heartbeat.routes.ts). A NEW PANEL that draws differently is
 * neither: the stand, 26.10, kept the rule a fix (A-277) had changed, because
 * the last push before the deploy came from the old panel and nothing asked
 * for another. Any change of drawing without an event (a deploy, a row edited
 * by hand) stays out of the nodes the same way, until an unrelated edit.
 *
 * So the push records what it sent: the sha256 of the request in canonical
 * JSON, under node:<id>:pushedSha (no TTL; the production Redis keeps its
 * volume). The sha only, never the request: it carries the chain's secrets
 * and the users' credentials. The check builds the request again with the
 * push's own builder and queues a push where the two differ or nothing was
 * recorded; run at backend start and once an hour.
 *
 * The request is built without `geo`, which needs the agent; a geo change
 * reaches the nodes through its rollout. The fingerprint is valid only if
 * the builder is deterministic, which a test guards.
 */

const keyOf = (nodeId: string) => `node:${nodeId}:pushedSha`;

/** JSON with every object's keys in order, arrays as they are. */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestFingerprint(req: ApplyInboundsRequest): string {
  return createHash('sha256').update(canonicalJson(req)).digest('hex');
}

/** After a push the agent applied: what it was sent, as a sha. */
export async function recordPushed(nodeId: string, req: ApplyInboundsRequest): Promise<void> {
  await redis.set(keyOf(nodeId), requestFingerprint(req));
}

/**
 * Queue a push for each node whose drawing is not what it was last sent.
 *
 * Online and degraded nodes only, and only those not already behind their
 * revision: a node whose push failed is reconcileNodeRevisions' (once an hour
 * per revision), and asking again here would bump its revision every hour and
 * bounce a node that refuses its config. `push` is enqueueNodePush, passed in
 * so this module does not import the queue.
 */
export async function checkRenderDrift(
  build: (nodeId: string) => Promise<ApplyInboundsRequest | null>,
  push: (nodeId: string) => Promise<void>,
): Promise<number> {
  const nodes = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text AS id, name FROM nodes
    WHERE deleted_at IS NULL AND status IN ('online', 'degraded') AND applied_revision >= desired_revision`;
  let queued = 0;
  for (const n of nodes) {
    try {
      const req = await build(n.id);
      if (!req) continue;
      const now = requestFingerprint(req);
      const sent = await redis.get(keyOf(n.id));
      if (sent === now) continue;
      getLogger().info(
        { node: n.name, recorded: sent !== null },
        '[inbound-sync] the drawing differs from the last push: queued',
      );
      await push(n.id);
      queued++;
    } catch (err) {
      // One node that cannot be built is its push's to report, not this check's.
      getLogger().warn({ node: n.name, err: err instanceof Error ? err.message : String(err) }, '[inbound-sync] drawing check skipped a node');
    }
  }
  return queued;
}
