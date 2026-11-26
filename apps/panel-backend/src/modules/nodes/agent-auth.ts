import type { FastifyRequest } from 'fastify';
import { prisma } from '../../prisma.js';
import { verifyHeartbeatToken } from './heartbeat-token.js';

/**
 * "Is this request from one of our agents?", asked in one place.
 *
 * The bearer is the HMAC token minted into the node's bootstrap payload, and
 * two node-facing surfaces check it: the heartbeat, which decides whether a node
 * keeps running, and the core download, which decides which bytes a node
 * installs. Written out twice they would drift.
 *
 * Soft-deleted nodes DO authenticate here: whether that is 410 or something else
 * is the caller's answer (both callers say 410 GONE).
 */
export type AgentBearer =
  | { ok: true; nodeId: string }
  | { ok: false; error: 'MISSING_BEARER' | 'INVALID_TOKEN' };

export async function verifyAgentBearer(request: FastifyRequest): Promise<AgentBearer> {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return { ok: false, error: 'MISSING_BEARER' };
  const token = auth.slice('Bearer '.length).trim();

  const verified = await verifyHeartbeatToken(token, async (nodeId) => {
    // Only fetch the secret column; we don't need the rest of the row
    // for verification. Soft-deleted rows DO get their secret returned
    // because we want valid-token-but-deleted to return 410, not 401.
    const row = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { heartbeatSecret: true },
    });
    return row ? Buffer.from(row.heartbeatSecret as Uint8Array) : null;
  });
  return verified ? { ok: true, nodeId: verified.nodeId } : { ok: false, error: 'INVALID_TOKEN' };
}
