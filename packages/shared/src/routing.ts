/**
 * Routing Templates (design plan E, R1a): panel-wide preset controlling the
 * routing rules emitted into full-config subscription formats
 * (clash / singbox / xrayjson). URI-list formats (plain) and wgconf carry no
 * routing section, so the preset does not apply to them.
 *
 *   - `proxy-all`: everything through the tunnel. Legacy behaviour; output
 *     is byte-identical to pre-R1 builds.
 *   - `ru-split` : ads/malware blocked, RU domains + RU IPs + private ranges
 *     direct, everything else (including blocked sites) through the tunnel.
 *   - `cn-split` : the China-direct mirror of `ru-split`. Ads/malware blocked,
 *     China domains (geosite:cn) + China IPs (geoip:cn) + private ranges
 *     direct, everything else through the tunnel. Same shape as `ru-split`;
 *     only the geo categories and the clean-DNS resolver differ (AliDNS
 *     223.5.5.5 instead of Yandex 77.88.8.8).
 *
 * Stored in AppSetting under `subscriptionRoutingPreset`; overridable per
 * request via `?routing=` on /sub (mirrors the `bundle` param pattern).
 */
export const ROUTING_PRESET_IDS = ['proxy-all', 'ru-split', 'cn-split'] as const;

export type RoutingPresetId = (typeof ROUTING_PRESET_IDS)[number];

export function isRoutingPresetId(value: unknown): value is RoutingPresetId {
  return (
    typeof value === 'string' &&
    (ROUTING_PRESET_IDS as readonly string[]).includes(value)
  );
}

/**
 * Stage 19: a rule "these names -> this DNS server", the operator's own
 * (a routing preset's `dnsRules`) or panel-wide (`subscriptionDnsRules`).
 * `match` is names only (geosite:TAG, domain:NAME, full:NAME, a bare name);
 * `server` is one of the four kinds DNS_SERVER_KINDS names. The format
 * builders and the screen read the same parse, so a string the API accepted is
 * one every reader can take apart.
 */
export interface DnsRule {
  match: string[];
  server: string;
  note: string;
}

export const MAX_DNS_RULES = 16;
export const MAX_DNS_RULE_NAMES = 64;

/**
 * udp: a bare IP, port 53. tcp: `tcp://IP[:port]`. tls (DoT): `tls://HOST[:port]`.
 * https (DoH): `https://HOST[:port]/path`. Measured on the cores (m19-01):
 * xray runs udp, tcp and https but not tls (it takes `tls://` for a host name
 * and does nothing); sing-box runs all four. `tcp` is the primary kind.
 */
export const DNS_SERVER_KINDS = ['udp', 'tcp', 'tls', 'https'] as const;
export type DnsServerKind = (typeof DNS_SERVER_KINDS)[number];

export const DNS_DEFAULT_PORTS: Record<DnsServerKind, number> = { udp: 53, tcp: 53, tls: 853, https: 443 };
export const DNS_DEFAULT_DOH_PATH = '/dns-query';

export interface ParsedDnsServer {
  kind: DnsServerKind;
  /** An IP (no brackets) for udp and tcp; an IP or a host name for tls and https. */
  host: string;
  port: number;
  /** https only, starting with `/`; empty for the others. */
  path: string;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isIpv4(s: string): boolean {
  return IPV4.test(s);
}

function isIpv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

function isHostName(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  const labels = s.split('.');
  // An all-numeric last label is an IPv4 attempt, not a name.
  if (/^\d+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((l) => HOST_LABEL.test(l));
}

function parsePort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** `[v6]:port`, `[v6]`, `host:port` or `host`, to host (no brackets) and port. */
function hostPort(s: string, defaultPort: number): { host: string; port: number } | null {
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const host = s.slice(1, end);
    if (!isIpv6(host)) return null;
    const rest = s.slice(end + 1);
    if (rest === '') return { host, port: defaultPort };
    if (!rest.startsWith(':')) return null;
    const port = parsePort(rest.slice(1));
    return port === null ? null : { host, port };
  }
  const colon = s.indexOf(':');
  if (colon < 0) return { host: s, port: defaultPort };
  if (s.indexOf(':', colon + 1) >= 0) return null; // a bare IPv6 with a scheme must be bracketed
  const port = parsePort(s.slice(colon + 1));
  return port === null ? null : { host: s.slice(0, colon), port };
}

/**
 * The structure of a `server` string, or null for anything that is not one of
 * the four kinds: `udp://`, an IP with a port and no scheme, `https://` with
 * no host, a name where UDP or TCP wants an IP, whitespace, a query string.
 * `https://HOST` with no path means `/dns-query`.
 */
export function parseDnsServer(raw: string): ParsedDnsServer | null {
  if (raw !== raw.trim() || raw === '' || /\s/.test(raw)) return null;
  const scheme = /^([a-z]+):\/\//.exec(raw);
  if (!scheme) {
    return isIpv4(raw) || isIpv6(raw) ? { kind: 'udp', host: raw, port: DNS_DEFAULT_PORTS.udp, path: '' } : null;
  }
  const kind = scheme[1];
  const rest = raw.slice(scheme[0].length);
  if (kind === 'tcp') {
    const hp = hostPort(rest, DNS_DEFAULT_PORTS.tcp);
    return hp && (isIpv4(hp.host) || isIpv6(hp.host)) ? { kind: 'tcp', ...hp, path: '' } : null;
  }
  if (kind === 'tls') {
    const hp = hostPort(rest, DNS_DEFAULT_PORTS.tls);
    return hp && (isIpv4(hp.host) || isIpv6(hp.host) || isHostName(hp.host)) ? { kind: 'tls', ...hp, path: '' } : null;
  }
  if (kind === 'https') {
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? DNS_DEFAULT_DOH_PATH : rest.slice(slash);
    if (/[?#]/.test(path)) return null;
    const hp = hostPort(authority, DNS_DEFAULT_PORTS.https);
    return hp && (isIpv4(hp.host) || isIpv6(hp.host) || isHostName(hp.host)) ? { kind: 'https', ...hp, path } : null;
  }
  return null;
}
