import { prisma } from '../../prisma.js';

/**
 * A WireGuard device as a device card, where devices are listed beside the
 * clients HWID tracks (the Remnawave-compatible API). A tunnel is named by the
 * address it was issued, not its number: numbers move when a device is
 * revoked, the address is what the person holding the config can see in it.
 */

export const WG_TUNNEL_PLATFORM = 'WireGuard/AmneziaWG';

/** The id a tunnel goes by among HWID devices: `wg:<device id>`. */
export const WG_HWID_PREFIX = 'wg:';

/** The profiles the user's squads grant: only addresses on those are ones the
 *  user could actually be holding (an address on a profile the user lost is
 *  not on any config they can fetch now). */
export async function servedProfileIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.groupProfile.findMany({
    where: { group: { members: { some: { userId } } } },
    select: { profileId: true },
  });
  return new Set(rows.map((r) => r.profileId));
}

/** The device's addresses on the served profiles, `/`-joined; every address
 *  when none is on a served profile (better than an empty name). */
export function wgTunnelAddresses(
  d: { peers: { ip: string; profileId: string }[] },
  served?: Set<string>,
): string {
  const served1 = served ? d.peers.filter((p) => served.has(p.profileId)) : d.peers;
  const list = (served1.length > 0 ? served1 : d.peers).map((p) => p.ip);
  return [...new Set(list)].join(' / ');
}

/** The device card's fields (hwid, platform, model, createdAt). */
export function describeWgTunnel(
  d: { id: string; createdAt: Date; peers: { ip: string; profileId: string }[] },
  served?: Set<string>,
) {
  return {
    hwid: `${WG_HWID_PREFIX}${d.id}`,
    platform: WG_TUNNEL_PLATFORM,
    deviceModel: wgTunnelAddresses(d, served) || null,
    createdAt: d.createdAt.toISOString(),
  };
}
