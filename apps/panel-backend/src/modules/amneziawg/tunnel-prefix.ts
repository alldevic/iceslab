// The node's real IPv6 prefix for the WireGuard-family tunnel (milestone 18.11):
// parsing, the overlap test, and the split into one /64 per interface. Pure.

/**
 * The shortest and the longest prefix a node may be given. A provider hands out
 * /64 down to /48 (a /56 is the common home one), /32 is the most a site holds;
 * longer than /64 leaves no room for a SLAAC-sized subnet, which is what a
 * tunnel interface gets.
 */
export const NODE_PREFIX_MIN_LEN = 32;
export const NODE_PREFIX_MAX_LEN = 64;

export interface NodePrefix {
  /** The 128-bit network address. */
  addr: bigint;
  len: number;
}

/** An IPv6 literal as a 128-bit number, or null (no zone, no embedded IPv4). */
export function ipv6ToBigInt(text: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const [head, tail] = halves as [string, string | undefined];
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...t];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  let n = 0n;
  for (const g of all) n = (n << 16n) | BigInt(parseInt(g, 16));
  return n;
}

/** RFC 5952 spelling: lowercase, the longest zero run (two groups or more) as `::`. */
export function bigIntToIpv6(n: bigint): string {
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (g[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  if (best.len < 2) return g.join(':');
  return `${g.slice(0, best.at).join(':')}::${g.slice(best.at + best.len).join(':')}`;
}

const mask = (len: number): bigint => (((1n << BigInt(len)) - 1n) << BigInt(128 - len));

/**
 * The prefix a node may carry, or null: `addr/len` with the host bits zero, a
 * GLOBAL unicast address (2000::/3: not ULA fc00::/7, not link-local fe80::/10,
 * not multicast), and a length from /32 to /64.
 */
export function parseNodePrefix(cidr: string): NodePrefix | null {
  const m = /^([0-9a-fA-F:]+)\/(\d{1,3})$/.exec(cidr.trim());
  if (!m) return null;
  const len = Number(m[2]);
  const addr = ipv6ToBigInt(m[1]!);
  if (addr === null || len < NODE_PREFIX_MIN_LEN || len > NODE_PREFIX_MAX_LEN) return null;
  if ((addr & mask(len)) !== addr) return null;
  if (addr >> 125n !== 1n) return null;
  return { addr, len };
}

export function isNodePrefix(cidr: string): boolean {
  return parseNodePrefix(cidr) !== null;
}

/** The canonical spelling the column holds, so two spellings of one prefix compare equal. */
export function normalizeNodePrefix(cidr: string): string | null {
  const p = parseNodePrefix(cidr);
  return p ? `${bigIntToIpv6(p.addr)}/${p.len}` : null;
}

/** Whether two IPv6 networks (any length) share an address: one holds the other. */
export function ipv6NetworksOverlap(a: { addr: bigint; len: number }, b: { addr: bigint; len: number }): boolean {
  const len = Math.min(a.len, b.len);
  return (a.addr & mask(len)) === (b.addr & mask(len));
}

/** Overlap of two prefixes given as text; anything unparsable overlaps nothing. */
export function nodePrefixOverlaps(a: string, b: string): boolean {
  const x = parseNodePrefix(a);
  const y = parseNodePrefix(b);
  return x !== null && y !== null && ipv6NetworksOverlap(x, y);
}

/** Overlap of two IPv6 networks of any length written as text (a profile's ULA /64 against a node's prefix). */
export function ipv6NetworksOverlapText(a: string, b: string): boolean {
  const parse = (c: string) => {
    const m = /^([0-9a-fA-F:]+)\/(\d{1,3})$/.exec(c.trim());
    const addr = m ? ipv6ToBigInt(m[1]!) : null;
    const len = m ? Number(m[2]) : 0;
    return addr !== null && len <= 128 ? { addr: addr & mask(len), len } : null;
  };
  const x = parse(a);
  const y = parse(b);
  return x !== null && y !== null && ipv6NetworksOverlap(x, y);
}

/**
 * The /64 number `index` (0-based) of a node prefix, in the four-group form the
 * tunnel's `subnet6` has (`2001:db8:77:1::/64`), or null when the prefix has no
 * such subnet: a /64 holds one, a /63 two, a /56 256.
 */
export function interfaceSubnet64(prefix: string, index: number): string | null {
  const p = parseNodePrefix(prefix);
  if (!p || !Number.isInteger(index) || index < 0) return null;
  if (BigInt(index) >= 1n << BigInt(64 - p.len)) return null;
  const top = (p.addr >> 64n) + BigInt(index);
  const g = [48n, 32n, 16n, 0n].map((s) => ((top >> s) & 0xffffn).toString(16));
  return `${g.join(':')}::/64`;
}
