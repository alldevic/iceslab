/**
 * A node's address as the operator types it and the panel stores it:
 * `host`, `host:port`, and for IPv6 also `v6`, `[v6]` and `[v6]:port`.
 *
 * One reader for the panel and the forms (they used to cut the string at a
 * colon, four ways, and a bare IPv6 lost its last group to every one of them).
 * No `node:net` here: the frontend imports this file.
 */

export type NodeHostKind = 'name' | 'ipv4' | 'ipv6';

export interface ParsedNodeAddress {
  /** Without brackets; an IPv6 literal in the canonical spelling (lower-case, compressed). */
  host: string;
  /** The port typed, or null when the address carries none. */
  port: number | null;
  kind: NodeHostKind;
}

/** The mTLS port the node agent listens on when the address names none. */
export const DEFAULT_NODE_AGENT_PORT = 1337;

const NAME_RE = /^[a-zA-Z0-9.-]+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function parseV4(s: string): number[] | null {
  if (!IPV4_RE.test(s)) return null;
  const parts = s.split('.').map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/**
 * The eight 16-bit groups of an IPv6 literal, or null when it is not one.
 * Accepts `::` and a dotted IPv4 tail; refuses a zone (`%eth0`) and brackets.
 */
function groupsOf(s: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.includes('.')) {
        // A dotted tail is the last two groups, and only at the very end.
        const v4 = parseV4(item);
        if (!v4 || i !== items.length - 1) return null;
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
        out.push(parseInt(item, 16));
      }
    }
    return out;
  };
  const head = read(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = read(halves[1]!);
  if (!tail) return null;
  // `::` stands for at least one group of zeros.
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** The canonical spelling of an IPv6 literal (RFC 5952 shape), or null when `s` is not one. */
export function canonicalIpv6(s: string): string | null {
  const g = groupsOf(s);
  if (!g) return null;
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function parsePort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Null when `address` is none of the accepted shapes. */
export function parseNodeAddress(address: string): ParsedNodeAddress | null {
  const s = address.trim();
  if (s === '') return null;

  if (s.startsWith('[')) {
    const m = /^\[([^\]]*)\](?::(.*))?$/.exec(s);
    if (!m) return null;
    const host = canonicalIpv6(m[1]!);
    if (!host) return null;
    if (m[2] === undefined) return { host, port: null, kind: 'ipv6' };
    const port = parsePort(m[2]);
    return port === null ? null : { host, port, kind: 'ipv6' };
  }

  const colons = s.split(':').length - 1;
  if (colons > 1) {
    // Several colons without brackets: all of it is the address, a port cannot be told apart.
    const host = canonicalIpv6(s);
    return host ? { host, port: null, kind: 'ipv6' } : null;
  }

  let hostPart = s;
  let port: number | null = null;
  if (colons === 1) {
    const idx = s.indexOf(':');
    hostPart = s.slice(0, idx);
    port = parsePort(s.slice(idx + 1));
    if (port === null) return null;
  }
  if (!NAME_RE.test(hostPart)) return null;
  return { host: hostPart, port, kind: IPV4_RE.test(hostPart) ? 'ipv4' : 'name' };
}

/** `host:port` for a form's two fields or a URL: an IPv6 host gets its brackets. */
export function joinNodeAddress(host: string, port: number | string): string {
  const h = host.trim().replace(/^\[(.*)\]$/, '$1');
  return `${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/**
 * What goes into `nodes.address`. A name or IPv4 is kept exactly as typed (the
 * rows already stored, and the unique index over them, do not move). An IPv6
 * literal gets ONE spelling whichever of the three forms was typed: bare when
 * the port is the default, `[v6]:port` otherwise, so `2001:db8::1`,
 * `[2001:db8::1]` and `[2001:db8::1]:1337` are the same row for the unique index.
 * Null when `address` is not an address.
 */
export function canonicalNodeAddress(address: string): string | null {
  const p = parseNodeAddress(address);
  if (!p) return null;
  if (p.kind !== 'ipv6') return address.trim();
  return p.port === null || p.port === DEFAULT_NODE_AGENT_PORT ? p.host : joinNodeAddress(p.host, p.port);
}

/** An IPv6 literal in either spelling (`v6` or `[v6]`), as the canonical bare one; null for anything else. */
export function canonicalIpv6Host(host: string): string | null {
  const s = host.trim();
  return canonicalIpv6(/^\[(.*)\]$/.exec(s)?.[1] ?? s);
}
