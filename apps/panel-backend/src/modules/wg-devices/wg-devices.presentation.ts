/**
 * How ONE wg tunnel is described to the buyer — in one place.
 *
 * Two things name a tunnel to a buyer, and they have to name it the same way:
 * the device card in the shop (built from the facade's device list) and the
 * "a new device connected" notification the shop sends when a tunnel is first
 * used. They are assembled in different modules from different queries, and a
 * name that differs between them is a buyer told about a device they then
 * cannot find in the list.
 *
 * The name is the ADDRESS, never the ordinal. `device=N` and the card's
 * position are both indexes into the LIVE set, so revoking the second tunnel
 * makes the former third one the second: the number is stable only until the
 * buyer uses the button next to it, which is exactly the moment they are
 * reading it. The address does not move that way — a surviving tunnel keeps
 * its own — and the buyer can read it in their own client, because
 * `Address = 10.68.0.28/32` sits in the file they imported.
 *
 * It identifies a tunnel among the LIVE ones, which is precisely the set the
 * buyer chooses from, and not for all time: revocation deletes the peer row
 * (the device row and its traffic are what survive), so the allocator can hand
 * the same address to a replacement tunnel later. That costs nothing here —
 * the old config still cannot connect, because WireGuard authenticates by key
 * and the key is gone from the node — but it is why this says "which tunnel of
 * yours is this" rather than "a name unique for all time".
 */

/** Named by protocol family rather than by flavour: the same keypair works with
 *  the WireGuard app and the AmneziaWG one, so calling it either would be wrong
 *  half the time. */
export const WG_TUNNEL_PLATFORM = 'WireGuard/AmneziaWG';

export interface WgTunnelForDisplay {
  id: string;
  createdAt: Date;
  peers: { ip: string; profileId: string }[];
}

/**
 * The addresses this tunnel is known by, as one string.
 *
 * ALL of them, not the first: one keypair serves every wg profile on the fleet,
 * and the allocator hands out an address PER PROFILE, with its own host part
 * each time. So a buyer holding one device has several addresses and their
 * config file contains exactly one — measured on the live panel, 03.09: device
 * one of a `main` buyer held `10.66.0.64`, `10.67.0.64`, `10.68.0.33` and
 * `10.69.0.33`, while the file the subscription handed them said
 * `Address = 10.68.0.33/32`. Naming the tunnel by the first would name it by an
 * address the buyer has never seen, which is worse than a number: a number at
 * least does not look like a fact.
 *
 * `served` narrows them to the profiles the buyer's squads actually give. wg
 * peers are allocated for every user of a wg-bearing node regardless of squad
 * (a known upstream defect — see HANDOFF), so without this the list carries
 * addresses from inbounds no config of theirs will ever contain. Absent or
 * empty means "do not narrow", which is what a caller that cannot resolve the
 * squads should pass: too many addresses is a worse answer than none, and none
 * is what filtering on an empty set would give.
 *
 * Empty happens for a tunnel whose peers were never allocated — the buyer has
 * not fetched a config since it was minted. Both readers below fall back to the
 * platform, which is the truth ("some wg tunnel") rather than a made-up name.
 */
export function wgTunnelAddresses(
  d: WgTunnelForDisplay,
  served?: ReadonlySet<string>,
): string {
  const narrowed =
    served && served.size > 0 ? d.peers.filter((p) => served.has(p.profileId)) : d.peers;
  const shown = narrowed.length > 0 ? narrowed : d.peers;
  return shown.map((p) => p.ip).join(' / ');
}

/**
 * The fields that IDENTIFY the tunnel, in the shape Remnawave's HWID device
 * carries them. Whatever else a caller adds (traffic, last seen — see
 * `mapWgTunnel`), this is the part that must not vary between them.
 *
 * `createdAt` is load-bearing rather than cosmetic: the shop hashes
 * `hwid + createdAt` into its dedupe fingerprint, so the pair has to be the
 * same on every delivery describing the same tunnel.
 */
export function describeWgTunnel(
  d: WgTunnelForDisplay,
  served?: ReadonlySet<string>,
): {
  hwid: string;
  platform: string;
  deviceModel: string;
  createdAt: string;
} {
  return {
    hwid: `wg:${d.id}`,
    platform: WG_TUNNEL_PLATFORM,
    deviceModel: wgTunnelAddresses(d, served),
    createdAt: d.createdAt.toISOString(),
  };
}
