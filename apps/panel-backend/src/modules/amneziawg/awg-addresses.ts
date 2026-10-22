import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import { allocatePeer, preallocatePeers } from './amneziawg.service.js';

/**
 * A-164 (P9, one owner of the rule): the AmneziaWG address a user is pushed
 * with, for the inbound push and for rolling a single user out alike.
 *
 * Before, only the inbound push allocated addresses; adding a user (created,
 * back to active) sent addUser with none, the agent puts no 1.x peer without
 * an address and takes the user off 3.1, so a new or returning user had no
 * AmneziaWG on any node until the next push of that node.
 */

/**
 * The AmneziaWG binding of each generation on a node that the agent ends up
 * serving: the last by port, as the push hands them over (the agent keeps the
 * last AWG inbound of a generation it is pushed, in port order).
 */
export async function awgBindingsOfNode(nodeId: string): Promise<{ one?: string; three?: string }> {
  const rows = await prisma.profileNodeBinding.findMany({
    where: { nodeId, enabled: true, profile: { enabled: true, protocol: 'amneziawg' } },
    orderBy: { port: 'asc' },
    select: { id: true, profile: { select: { awgProtocol: true } } },
  });
  const one = rows.filter((r) => r.profile.awgProtocol !== 3).at(-1)?.id;
  const three = rows.filter((r) => r.profile.awgProtocol === 3).at(-1)?.id;
  return { ...(one ? { one } : {}), ...(three ? { three } : {}) };
}

/**
 * Each user's address in the subnet of the profile behind `bindingId`, or an
 * empty map when there is no such binding.
 *
 * Allocated serially (allocatePeer is racy under concurrency, IP slots aren't
 * unique-indexed): one bulk allocation for the set, stragglers falling back to
 * the per-user allocator. A user whose allocation fails is left out; their
 * other protocols still work.
 */
export async function allocateAwgAddresses(
  bindingId: string | undefined,
  users: { id: string; username: string; amneziawgPublicKey: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!bindingId) return out;
  const row = await prisma.profileNodeBinding.findUnique({
    where: { id: bindingId },
    select: { profileId: true, profile: { select: { config: true } } },
  });
  if (!row) return out;
  const profileId = row.profileId;
  const subnet = ((row.profile.config ?? {}) as { subnet?: string }).subnet ?? '10.66.66.0/24';
  const awgUsers = users.filter((u) => u.amneziawgPublicKey);
  if (awgUsers.length === 0) return out;
  const bulk = await preallocatePeers(
    profileId,
    awgUsers.map((u) => u.id),
    subnet,
  ).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    getLogger().info(`[awg] bulk preallocatePeers on profile ${profileId} FAILED, per-user fallback: ${detail}`);
    return new Map<string, string>();
  });
  for (const u of awgUsers) {
    let ip = bulk.get(u.id);
    if (!ip) {
      try {
        ip = (await allocatePeer(profileId, u.id, subnet)).ip;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        getLogger().info(`[awg] allocatePeer ${u.username} on profile ${profileId} FAILED: ${detail}`);
        continue;
      }
    }
    out.set(u.id, ip);
  }
  return out;
}
