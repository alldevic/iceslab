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
  peers: { ip: string }[];
}

/**
 * The address that identifies this tunnel, or `''` when it has none yet.
 *
 * One keypair serves every wg profile on the fleet, so a tunnel holds one
 * address per profile and they are all the same device; the first is enough to
 * tell two tunnels apart, which is all the name is for.
 *
 * Empty happens for a tunnel whose peers were never allocated — the buyer has
 * not fetched a config since it was minted. Both readers below fall back to the
 * platform, which is the truth ("some wg tunnel") rather than a made-up name.
 */
export function wgTunnelAddress(d: WgTunnelForDisplay): string {
  return d.peers[0]?.ip ?? '';
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
export function describeWgTunnel(d: WgTunnelForDisplay): {
  hwid: string;
  platform: string;
  deviceModel: string;
  createdAt: string;
} {
  return {
    hwid: `wg:${d.id}`,
    platform: WG_TUNNEL_PLATFORM,
    deviceModel: wgTunnelAddress(d),
    createdAt: d.createdAt.toISOString(),
  };
}
