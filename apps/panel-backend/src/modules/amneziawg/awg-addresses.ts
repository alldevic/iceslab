import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import type { AmneziawgPeerCred } from '@iceslab/shared';
import { allocatePeer, DEFAULT_SUBNET, preallocatePeers, type PeerDevice } from './amneziawg.service.js';
import { activeDevicesOf } from '../wg-devices/wg-devices.service.js';

/**
 * A-164 (P9, one owner of the rule): the AmneziaWG peers a user is pushed
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

/** One AmneziaWG profile behind a binding: where its addresses come from and
 *  whether its peers take a preshared key. */
async function profileOf(bindingId: string | undefined) {
  if (!bindingId) return null;
  const row = await prisma.profileNodeBinding.findUnique({
    where: { id: bindingId },
    select: { profileId: true, profile: { select: { config: true } } },
  });
  if (!row) return null;
  const cfg = (row.profile.config ?? {}) as { subnet?: string; presharedKey?: boolean };
  return { profileId: row.profileId, subnet: cfg.subnet ?? DEFAULT_SUBNET, presharedKey: cfg.presharedKey === true };
}

/**
 * Each device's address in a profile's subnet. Allocated serially (allocatePeer
 * is racy under concurrency): one bulk allocation for the set, stragglers
 * falling back to the per-device allocator. A device whose allocation fails is
 * left out; the user's other devices and protocols still work.
 */
async function addressesOf(
  profile: { profileId: string; subnet: string },
  devices: (PeerDevice & { username: string })[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (devices.length === 0) return out;
  const bulk = await preallocatePeers(profile.profileId, devices, profile.subnet).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    getLogger().info(`[awg] bulk preallocatePeers on profile ${profile.profileId} FAILED, per-device fallback: ${detail}`);
    return new Map<string, string>();
  });
  for (const d of devices) {
    let ip = bulk.get(d.id);
    if (!ip) {
      try {
        ip = (await allocatePeer(profile.profileId, d, profile.subnet)).ip;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        getLogger().info(`[awg] allocatePeer ${d.username} (device ${d.id}) on profile ${profile.profileId} FAILED: ${detail}`);
        continue;
      }
    }
    out.set(d.id, ip);
  }
  return out;
}

/** The AmneziaWG part of a user's credentials on one node. */
export interface AwgCredentials {
  /** Device 1, for agents older than devices, which read these three alone. */
  amneziawgPublicKey?: string;
  amneziawgAllowedIp?: string;
  amneziawgAllowedIp3?: string;
  /** Every live device with an address there; `[]` takes the user's peers off. */
  amneziawgPeers: AmneziawgPeerCred[];
}

/**
 * The AmneziaWG credentials of each user who reaches an AmneziaWG binding of
 * the node (`one` is the 1.x binding, `three` the 3.1 one): a peer per live
 * device, with its address on each generation the user reaches and, where
 * that profile asks for one, its preshared key. Users who reach neither are
 * not in the map, and their record carries no AmneziaWG fields.
 *
 * The push and the rollout of one user both read this, so the peer set a node
 * holds for a user is the same whichever of them wrote it last.
 */
export async function awgCredentialsOf(
  bindings: { one?: string; three?: string },
  users: { id: string; username: string; reachesOne: boolean; reachesThree: boolean }[],
): Promise<Map<string, AwgCredentials>> {
  const out = new Map<string, AwgCredentials>();
  const [one, three] = await Promise.all([profileOf(bindings.one), profileOf(bindings.three)]);
  const reaching = users.filter((u) => (one && u.reachesOne) || (three && u.reachesThree));
  if (reaching.length === 0) return out;
  const devicesByUser = await activeDevicesOf(reaching.map((u) => u.id));
  const devicesReaching = (gen: 'reachesOne' | 'reachesThree') =>
    reaching.filter((u) => u[gen]).flatMap((u) => (devicesByUser.get(u.id) ?? []).map((d) => ({ id: d.id, userId: u.id, username: u.username })));
  const [ip1, ip3] = await Promise.all([
    one ? addressesOf(one, devicesReaching('reachesOne')) : new Map<string, string>(),
    three ? addressesOf(three, devicesReaching('reachesThree')) : new Map<string, string>(),
  ]);
  for (const u of reaching) {
    const peers: AmneziawgPeerCred[] = [];
    for (const d of devicesByUser.get(u.id) ?? []) {
      const a1 = u.reachesOne ? ip1.get(d.id) : undefined;
      const a3 = u.reachesThree ? ip3.get(d.id) : undefined;
      if (!a1 && !a3) continue;
      peers.push({
        publicKey: d.publicKey,
        ...(a1 ? { allowedIp: a1 } : {}),
        ...(a3 ? { allowedIp3: a3 } : {}),
        ...(a1 && one?.presharedKey && d.presharedKey ? { presharedKey: d.presharedKey } : {}),
        ...(a3 && three?.presharedKey && d.presharedKey ? { presharedKey3: d.presharedKey } : {}),
      });
    }
    const first = peers[0];
    out.set(u.id, {
      amneziawgPeers: peers,
      ...(first
        ? {
            amneziawgPublicKey: first.publicKey,
            ...(first.allowedIp ? { amneziawgAllowedIp: first.allowedIp } : {}),
            ...(first.allowedIp3 ? { amneziawgAllowedIp3: first.allowedIp3 } : {}),
          }
        : {}),
    });
  }
  return out;
}
