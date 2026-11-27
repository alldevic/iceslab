import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import type { AmneziawgPeerCred } from '@iceslab/shared';
import { allocatePeer, DEFAULT_SUBNET, preallocatePeers, type PeerDevice } from './amneziawg.service.js';
import { ipv6OfIpv4InPrefix } from './amneziawg.subnet.js';
import { NO_TUNNEL_IPV6, tunnelAddressing, type TunnelInterface, type TunnelIpv6 } from './awg-ipv6.js';
import { ensureDevicesForUsers, type WgDeviceRow } from '../wg-devices/wg-devices.service.js';

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

/**
 * The plain WireGuard binding of a node the agent ends up serving (9.2): the
 * last by port, as for AmneziaWG (the agent keeps one plain inbound).
 */
export async function wireguardBindingOfNode(nodeId: string): Promise<string | undefined> {
  const rows = await prisma.profileNodeBinding.findMany({
    where: { nodeId, enabled: true, profile: { enabled: true, protocol: 'wireguard' } },
    orderBy: { port: 'asc' },
    select: { id: true },
  });
  return rows.at(-1)?.id;
}

/**
 * One profile behind a binding: where its addresses come from, and whether its
 * devices' peers carry a preshared key (milestone 9.5). The flag is read from
 * the binding's merged config, the one the subscription reads, so the key is in
 * the node's peer exactly when it is in the client's config.
 */
async function profileOf(
  bindingId: string | undefined,
): Promise<{ profileId: string; subnet: string; subnet6?: string; presharedKey: boolean } | null> {
  if (!bindingId) return null;
  const row = await prisma.profileNodeBinding.findUnique({
    where: { id: bindingId },
    select: { profileId: true, overrides: true, profile: { select: { config: true } } },
  });
  if (!row) return null;
  const config = { ...((row.profile.config ?? {}) as object), ...((row.overrides ?? {}) as object) } as {
    subnet?: string;
    subnet6?: string;
    presharedKey?: boolean;
  };
  return {
    profileId: row.profileId,
    subnet: config.subnet ?? DEFAULT_SUBNET,
    ...(config.subnet6 ? { subnet6: config.subnet6 } : {}),
    presharedKey: config.presharedKey === true,
  };
}

/**
 * Each device's address in a profile's subnet (an AmneziaWG or a plain WireGuard
 * one: both keep their peers in one table). Allocated serially (allocatePeer is
 * racy under concurrency, IP slots aren't unique-indexed): one bulk allocation
 * for the set, stragglers falling back to the per-device allocator. A device
 * whose allocation fails is left out; the user's other devices and protocols
 * still work.
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

/** The WireGuard-family part of a user's credentials on one node. */
export interface WgCredentials {
  /** Device 1, for agents older than devices, which read these alone. */
  amneziawgPublicKey?: string;
  amneziawgAllowedIp?: string;
  amneziawgAllowedIp3?: string;
  wireguardPublicKey?: string;
  wireguardAllowedIp?: string;
  /** Device 1's IPv6 on each interface that carries it in the tunnel (18.9). */
  amneziawgAllowedIp6?: string;
  amneziawgAllowedIp3v6?: string;
  wireguardAllowedIp6?: string;
  /** Every live device with an address there; `[]` takes the user's peers off. */
  amneziawgPeers: AmneziawgPeerCred[];
}

/**
 * The WireGuard-family credentials of each user who reaches a binding of the
 * node (`one` the AmneziaWG 1.x binding, `three` the 3.1 one, `wg` the plain
 * WireGuard one): a peer per live device, with its address on each interface
 * the user reaches. The devices are issued here to the user's count, the number
 * the subscription reads. Users who reach none are not in the map, and their
 * record carries no peer list (an agent reads that as no change).
 *
 * `ipv6` (18.9, tunnelIpv6OfNode of the node): the interfaces that carry IPv6 in
 * the tunnel. A peer on such an interface whose profile has a `subnet6` also
 * gets its IPv6, derived from its IPv4 address (in the node's real /64 for an
 * interface that has one, 18.11); any other peer is as before, byte for byte.
 *
 * The push and the rollout of one user both read this, so the peer set a node
 * holds for a user is the same whichever of them wrote it last. `issuedTo` are
 * the users who were just given devices.
 */
export async function wgCredentialsOf(
  bindings: { one?: string; three?: string; wg?: string },
  users: { id: string; username: string; reachesOne: boolean; reachesThree: boolean; reachesWg: boolean }[],
  ipv6: TunnelIpv6 = NO_TUNNEL_IPV6,
): Promise<{ creds: Map<string, WgCredentials>; issuedTo: string[] }> {
  const creds = new Map<string, WgCredentials>();
  const [one, three, wg] = await Promise.all([profileOf(bindings.one), profileOf(bindings.three), profileOf(bindings.wg)]);
  const reaching = users.filter((u) => (one && u.reachesOne) || (three && u.reachesThree) || (wg && u.reachesWg));
  if (reaching.length === 0) return { creds, issuedTo: [] };
  const { devices: devicesByUser, issuedTo } = await ensureDevicesForUsers(reaching.map((u) => u.id));
  const devicesReaching = (flag: 'reachesOne' | 'reachesThree' | 'reachesWg') =>
    reaching
      .filter((u) => u[flag])
      .flatMap((u) => (devicesByUser.get(u.id) ?? []).map((d) => ({ id: d.id, userId: u.id, username: u.username })));
  const ip1 = one ? await addressesOf(one, devicesReaching('reachesOne')) : new Map<string, string>();
  const ip3 = three ? await addressesOf(three, devicesReaching('reachesThree')) : new Map<string, string>();
  const ipWg = wg ? await addressesOf(wg, devicesReaching('reachesWg')) : new Map<string, string>();
  for (const u of reaching) {
    const peers: AmneziawgPeerCred[] = [];
    const devices: WgDeviceRow[] = devicesByUser.get(u.id) ?? [];
    for (const d of devices) {
      const a1 = one && u.reachesOne ? ip1.get(d.id) : undefined;
      const a3 = three && u.reachesThree ? ip3.get(d.id) : undefined;
      const aw = wg && u.reachesWg ? ipWg.get(d.id) : undefined;
      if (!a1 && !a3 && !aw) continue;
      const v6 = (addr: string | undefined, iface: TunnelInterface, p: { subnet6?: string } | null) => {
        const plan = addr ? tunnelAddressing(ipv6, iface, p?.subnet6) : undefined;
        return addr && plan ? ipv6OfIpv4InPrefix(plan.subnet6, addr) : undefined;
      };
      const a16 = v6(a1, 'one', one);
      const a36 = v6(a3, 'three', three);
      const aw6 = v6(aw, 'wg', wg);
      // The device's one preshared key, on each interface whose profile asks
      // for it and the device has an address on. Never an empty string: the
      // agent renders no line for an absent key, and `PresharedKey = ` for ''.
      const psk = d.presharedKey || undefined;
      peers.push({
        publicKey: d.publicKey,
        ...(a1 ? { allowedIp: a1 } : {}),
        ...(a3 ? { allowedIp3: a3 } : {}),
        ...(aw ? { wireguardAllowedIp: aw } : {}),
        ...(a16 ? { allowedIp6: a16 } : {}),
        ...(a36 ? { allowedIp3v6: a36 } : {}),
        ...(aw6 ? { wireguardAllowedIp6: aw6 } : {}),
        ...(a1 && psk && one?.presharedKey ? { presharedKey: psk } : {}),
        ...(a3 && psk && three?.presharedKey ? { presharedKey3: psk } : {}),
        ...(aw && psk && wg?.presharedKey ? { wireguardPresharedKey: psk } : {}),
      });
    }
    // The single fields are device 1's: what an agent older than the list reads.
    const first = devices[0];
    const firstPeer = first ? peers.find((p) => p.publicKey === first.publicKey) : undefined;
    creds.set(u.id, {
      amneziawgPeers: peers,
      ...(first ? { amneziawgPublicKey: first.publicKey } : {}),
      ...(firstPeer?.allowedIp ? { amneziawgAllowedIp: firstPeer.allowedIp } : {}),
      ...(firstPeer?.allowedIp3 ? { amneziawgAllowedIp3: firstPeer.allowedIp3 } : {}),
      ...(first && firstPeer?.wireguardAllowedIp
        ? { wireguardPublicKey: first.publicKey, wireguardAllowedIp: firstPeer.wireguardAllowedIp }
        : {}),
      ...(firstPeer?.allowedIp6 ? { amneziawgAllowedIp6: firstPeer.allowedIp6 } : {}),
      ...(firstPeer?.allowedIp3v6 ? { amneziawgAllowedIp3v6: firstPeer.allowedIp3v6 } : {}),
      ...(firstPeer?.wireguardAllowedIp6 ? { wireguardAllowedIp6: firstPeer.wireguardAllowedIp6 } : {}),
    });
  }
  return { creds, issuedTo };
}
