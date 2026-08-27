import type { FastifyRequest } from 'fastify';
import { prisma } from '../../prisma.js';
import { verifyHeartbeatToken } from './heartbeat-token.js';

/**
 * "Is this request from one of our agents?", asked in one place.
 *
 * The bearer is the HMAC token minted into the node's bootstrap payload, and
 * two node-facing surfaces now check it: the heartbeat, which decides whether a
 * node keeps running, and the core download, which decides which bytes a node
 * installs. Written out twice they would drift, and the half that drifted would
 * be the newer one — which is the shape this fork keeps finding.
 *
 * Soft-deleted nodes DO authenticate here. Whether a deleted node is told to go
 * away (410) or simply refused is the CALLER's decision and the two differ:
 * the heartbeat answers 410 so the agent self-destructs, while a core download
 * has nothing useful to say to a node that no longer exists.
 */
export async function verifyAgentBearer(
  request: FastifyRequest,
): Promise<{ nodeId: string } | null> {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return verifyHeartbeatToken(token, async (nodeId) => {
    // Only the secret column. Soft-deleted rows return theirs too, so that a
    // valid-token-but-deleted node reaches the caller's own answer instead of
    // being told its token is bad.
    const row = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { heartbeatSecret: true },
    });
    return row ? Buffer.from(row.heartbeatSecret as Uint8Array) : null;
  });
}
