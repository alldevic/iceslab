// Pure CIDR helpers for AmneziaWG IP allocation. The peers' addresses are
// allocated from the IPv4 subnet only; the IPv6 half (milestone 18.9) is the
// tunnel's second address, DERIVED from the IPv4 one, below.
import { randomBytes } from 'node:crypto';

export interface SubnetRange {
  base: number;
  prefix: number;
  serverIp: number;
  firstUsable: number;
  lastUsable: number;
}

export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255 || p === '') {
      throw new Error(`Invalid octet in ${ip}`);
    }
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Reserves three addresses inside the subnet:
//   .0   network
//   .1   server / gateway (the awg interface itself)
//   .255 (or last) broadcast
// Everything else is handed to peers.
export function parseSubnet(cidr: string): SubnetRange {
  const slash = cidr.indexOf('/');
  if (slash < 1) throw new Error(`Invalid CIDR: ${cidr}`);
  const ipStr = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`Invalid prefix /${prefix} (must be /8..30)`);
  }
  const baseRaw = ipToInt(ipStr);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const base = (baseRaw & mask) >>> 0;
  const broadcast = (base | (~mask >>> 0)) >>> 0;
  const serverIp = base + 1;
  const firstUsable = serverIp + 1;
  const lastUsable = broadcast - 1;
  if (firstUsable > lastUsable) {
    throw new Error(`Subnet ${cidr} too small to host any peers`);
  }
  return { base, prefix, serverIp, firstUsable, lastUsable };
}

// ───── IPv6 inside the tunnel (milestone 18.9) ─────
//
// A profile may carry `subnet6`, a ULA /64 beside its IPv4 subnet. No address is
// allocated from it and nothing is stored: a peer's IPv6 is its IPv4 address in
// the low 32 bits of the /64, which is one-to-one both ways (so `amneziawg_peers`
// does not change, and an address can be read off by eye: 10.66.66.7 is
// `<prefix>::a42:4207`).

/**
 * A ULA /64 as `fdXX:XXXX:XXXX:XXXX::/64`, the shape the schema holds and the
 * form offers: fc00::/7, exactly /64, the interface identifier half zero. The
 * four groups are as written; shorter spellings (`fd00:1::/64`) are not taken, so
 * two spellings of one prefix cannot get past the overlap check.
 */
export const SUBNET6_PATTERN = /^f[cd][0-9a-f]{2}(:[0-9a-f]{1,4}){3}::\/64$/i;

/** The four 16-bit groups of the /64 prefix, or null when it is not a ULA /64. */
export function parseSubnet6(cidr: string): [number, number, number, number] | null {
  if (!SUBNET6_PATTERN.test(cidr)) return null;
  const groups = cidr.slice(0, cidr.indexOf('::')).split(':').map((g) => parseInt(g, 16));
  return groups.length === 4 ? (groups as [number, number, number, number]) : null;
}

export function isSubnet6(cidr: string): boolean {
  return parseSubnet6(cidr) !== null;
}

/** The canonical (lowercase) spelling, for comparing two prefixes. */
export function normalizeSubnet6(cidr: string): string | null {
  const g = parseSubnet6(cidr);
  return g ? `${g.map((x) => x.toString(16)).join(':')}::/64` : null;
}

/** A random ULA /64 (RFC 4193: `fd`, a 40-bit global id, a 16-bit subnet id). */
export function generateSubnet6(random: (n: number) => Uint8Array = randomBytes): string {
  const b = random(7);
  const g = (i: number) => ((b[i]! << 8) | b[i + 1]!).toString(16);
  return `fd${b[0]!.toString(16).padStart(2, '0')}:${g(1)}:${g(3)}:${g(5)}::/64`;
}

/**
 * The peer's (or the server's) IPv6 address for an IPv4 one: the /64 prefix,
 * 32 zero bits, then the four IPv4 octets. Throws on a prefix that is not a
 * ULA /64. Works for any IPv4 subnet width, since all 32 bits go in.
 */
export function ipv6OfIpv4(subnet6: string, ipv4: string): string {
  const prefix = parseSubnet6(subnet6);
  if (!prefix) throw new Error(`Invalid IPv6 subnet: ${subnet6}`);
  const n = ipToInt(ipv4);
  const hex = (x: number) => x.toString(16);
  const hi = n >>> 16;
  const lo = n & 0xffff;
  const head = prefix.map(hex).join(':');
  // A zero high half would leave `...:0:0:0:7`; spelled out in full it stays
  // readable and compares as a string.
  return `${head}:0:0:${hex(hi)}:${hex(lo)}`;
}

/** The IPv4 address an IPv6 one of the tunnel was derived from, or null. */
export function ipv4OfIpv6(subnet6: string, ipv6: string): string | null {
  const prefix = parseSubnet6(subnet6);
  const m = /^((?:[0-9a-f]{1,4}:){4})0:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6);
  if (!prefix || !m) return null;
  const head = m[1]!.slice(0, -1).split(':').map((g) => parseInt(g, 16));
  if (head.some((g, i) => g !== prefix[i])) return null;
  return intToIp(((parseInt(m[2]!, 16) << 16) | parseInt(m[3]!, 16)) >>> 0);
}

/** The server's address on the interface: derived from its IPv4 (.1) one. */
export function serverIpv6(subnet6: string, subnet: string): string {
  return ipv6OfIpv4(subnet6, intToIp(parseSubnet(subnet).serverIp));
}
