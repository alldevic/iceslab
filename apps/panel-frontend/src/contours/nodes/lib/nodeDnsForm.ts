import type { DnsCfg } from '@iceslab/shared';
import type { Node } from '@/lib/domain/nodes';

/**
 * The node's DNS as a form: the logic of the editor, apart from its markup.
 *
 * The limits are those of `DnsSchema` (panel-backend nodes.schemas.ts): 1..16
 * servers, an address of 1..253, at most 64 domains of 1..253 each, at most 32
 * `expectIps` of 1..64 each. They are checked here so that a 17th server or a
 * 65th domain is said at the field and never reaches the server as a 400.
 *
 * Every list is typed as text, one entry per line (a comma works too), because
 * a domain entry is a rule line (`full:`, `regexp:`, `geosite:`, `ext:set:tag`)
 * and a row of chips would make the operator fight the keyboard for each one.
 */
export const DNS_MAX_SERVERS = 16;
export const DNS_MAX_ADDRESS = 253;
export const DNS_MAX_DOMAINS = 64;
export const DNS_MAX_DOMAIN = 253;
export const DNS_MAX_EXPECT_IPS = 32;
export const DNS_MAX_EXPECT_IP = 64;

export type DnsQueryStrategy = '' | 'UseIP' | 'UseIPv4' | 'UseIPv6';

export interface DnsServerForm {
  address: string;
  /** Typed text, see `splitList`. Empty = the server answers everything. */
  domains: string;
  expectIps: string;
  skipFallback: boolean;
}

export interface DnsForm {
  /** Empty = no DNS of its own: the node uses its built-in resolvers. */
  servers: DnsServerForm[];
  /** '' = the core's default. */
  queryStrategy: DnsQueryStrategy;
  disableCache: boolean;
}

export function emptyDnsServer(): DnsServerForm {
  return { address: '', domains: '', expectIps: '', skipFallback: false };
}

/** The stored setting as the form's first state. `null` and absent are one answer. */
export function dnsDefaults(stored: DnsCfg | null | undefined): DnsForm {
  return {
    servers: (stored?.servers ?? []).map((s) => ({
      address: s.address,
      domains: (s.domains ?? []).join('\n'),
      expectIps: (s.expectIps ?? []).join('\n'),
      skipFallback: s.skipFallback ?? false,
    })),
    queryStrategy: stored?.queryStrategy ?? '',
    disableCache: stored?.disableCache ?? false,
  };
}

/** Typed list to entries: newline or comma, trimmed, blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
}

export type DnsProblemCode = 'required' | 'tooLong' | 'tooMany';

export interface DnsProblem {
  /** The server row; null for the list itself. */
  index: number | null;
  field: 'servers' | 'address' | 'domains' | 'expectIps';
  code: DnsProblemCode;
  /** The limit that was crossed, for the sentence. */
  limit?: number;
}

/**
 * What the server would refuse, found before the request. Empty = the form may
 * be sent. A blank row is `required` on its address, not dropped silently: the
 * operator added it and a save that quietly lost it would look like a bug.
 */
export function dnsProblems(form: DnsForm): DnsProblem[] {
  const out: DnsProblem[] = [];
  if (form.servers.length > DNS_MAX_SERVERS) {
    out.push({ index: null, field: 'servers', code: 'tooMany', limit: DNS_MAX_SERVERS });
  }
  form.servers.forEach((s, index) => {
    const address = s.address.trim();
    if (address === '') out.push({ index, field: 'address', code: 'required' });
    else if (address.length > DNS_MAX_ADDRESS) {
      out.push({ index, field: 'address', code: 'tooLong', limit: DNS_MAX_ADDRESS });
    }
    const domains = splitList(s.domains);
    if (domains.length > DNS_MAX_DOMAINS) {
      out.push({ index, field: 'domains', code: 'tooMany', limit: DNS_MAX_DOMAINS });
    } else if (domains.some((d) => d.length > DNS_MAX_DOMAIN)) {
      out.push({ index, field: 'domains', code: 'tooLong', limit: DNS_MAX_DOMAIN });
    }
    const ips = splitList(s.expectIps);
    if (ips.length > DNS_MAX_EXPECT_IPS) {
      out.push({ index, field: 'expectIps', code: 'tooMany', limit: DNS_MAX_EXPECT_IPS });
    } else if (ips.some((e) => e.length > DNS_MAX_EXPECT_IP)) {
      out.push({ index, field: 'expectIps', code: 'tooLong', limit: DNS_MAX_EXPECT_IP });
    }
  });
  return out;
}

/**
 * The form as the server's `dns`. No servers is `null`: the reset, which takes
 * the setting off the node. The strategy and the cache switch say nothing
 * without a server to apply to, so they go nowhere either.
 */
export function dnsBody(form: DnsForm): DnsCfg | null {
  if (form.servers.length === 0) return null;
  const cfg: DnsCfg = {
    servers: form.servers.map((s) => ({
      address: s.address.trim(),
      domains: splitList(s.domains),
      expectIps: splitList(s.expectIps),
      skipFallback: s.skipFallback,
    })),
  };
  if (form.queryStrategy !== '') cfg.queryStrategy = form.queryStrategy;
  if (form.disableCache) cfg.disableCache = true;
  return cfg;
}

/**
 * The `dns` of the node's PUT: only when it differs from the stored one, so
 * that saving the name does not re-push the node's config. Both sides go
 * through `dnsBody`, since the server fills the empty lists in on its own and
 * a stored setting never reads back byte for byte as it was sent.
 */
export function dnsPatch(
  stored: DnsCfg | null | undefined,
  form: DnsForm,
): { dns?: DnsCfg | null } {
  const next = dnsBody(form);
  const was = dnsBody(dnsDefaults(stored));
  return JSON.stringify(next) === JSON.stringify(was) ? {} : { dns: next };
}

/** Does the form carry anything the collapsed «advanced» block holds. */
export function dnsHasAdvanced(form: DnsForm): boolean {
  return (
    form.queryStrategy !== '' || form.disableCache || form.servers.some((s) => splitList(s.expectIps).length > 0)
  );
}

/** One row of the list of nodes: how much DNS the node carries. */
export interface DnsSummary {
  servers: number;
  /** Domain entries over all servers; a server with none answers everything. */
  domains: number;
}

export function dnsSummary(node: Pick<Node, 'dns'>): DnsSummary {
  const servers = node.dns?.servers ?? [];
  return { servers: servers.length, domains: servers.reduce((n, s) => n + (s.domains?.length ?? 0), 0) };
}

/** 19.12: how many rules the node carries from presets and the panel-wide rules, and from how many sources. Zero for a server older than the field. */
export function carriedSummary(node: Pick<Node, 'carriedDns'>): { rules: number; sources: number } {
  const sources = (node.carriedDns ?? []).filter((s) => s.rules.length > 0);
  return { rules: sources.reduce((n, s) => n + s.rules.length, 0), sources: sources.length };
}
