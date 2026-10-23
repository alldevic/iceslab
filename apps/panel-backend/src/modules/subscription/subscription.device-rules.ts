import { isIP } from 'node:net';
import type { DeviceRouteRule } from '../routing-presets/routing-presets.builtins.js';

/**
 * A-229 part 4: a device routing preset's rules, as each client format writes
 * them. One structure (DeviceRouteRule[]) for the built-in presets
 * (BUILTIN_PRESET_RULES) and the operator's own, so a preset reads the same in
 * xray-json, Clash and sing-box and the built-ins have no second copy.
 *
 * A rule's matchers are alternatives: any one of them matching is a match.
 * xray ANDs the fields of one routing rule, so each kind of matcher (names,
 * addresses, ports) becomes its own xray rule with the same target; Clash has
 * one line per matcher anyway; sing-box ORs the members of one list, so the
 * lists of a kind stay together. First match wins in all three, and splitting
 * a rule into consecutive rules with one target keeps that.
 *
 * Matcher grammar is the one the API admits (routing-presets.rules.ts,
 * matcherKind): geosite:TAG, geoip:TAG, domain:/full:/keyword:/regexp:, a bare
 * hostname, an IP or a CIDR, port:N or port:N-M.
 */

type Kind = 'domain' | 'ip' | 'port';

function kindOf(m: string): Kind {
  if (m.startsWith('port:')) return 'port';
  if (m.startsWith('geoip:')) return 'ip';
  const bare = m.split('/')[0]!;
  if (isIP(bare) !== 0) return 'ip';
  return 'domain';
}

function byKind(match: readonly string[]): Record<Kind, string[]> {
  const out: Record<Kind, string[]> = { domain: [], ip: [], port: [] };
  for (const m of match) out[kindOf(m)].push(m);
  return out;
}

const port = (m: string): string => m.slice('port:'.length);

// ---------------------------------------------------------------- xray

/** Where a `proxy` rule sends traffic: an outbound tag, a balancer, or nowhere
 *  (no proxy in the config: the rule is left out, the catch-all is direct). */
export type XrayProxyTarget = { outboundTag: string } | { balancerTag: string } | null;

/**
 * xray routing rules. Every spelling of a name or an address is xray's own
 * (geosite:, geoip:, domain:, full:, keyword:, regexp:, CIDR), so they pass as
 * written; ports join into xray's "a,b-c" string.
 */
export function xrayDeviceRules(rules: readonly DeviceRouteRule[], proxy: XrayProxyTarget): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rules) {
    const target =
      r.action === 'direct' ? { outboundTag: 'direct' } : r.action === 'block' ? { outboundTag: 'block' } : proxy;
    if (!target) continue;
    const k = byKind(r.match);
    if (k.domain.length) out.push({ type: 'field', domain: k.domain, ...target });
    if (k.ip.length) out.push({ type: 'field', ip: k.ip, ...target });
    if (k.port.length) out.push({ type: 'field', port: k.port.map(port).join(','), ...target });
  }
  return out;
}

// ---------------------------------------------------------------- Clash

/**
 * `geoip:private` as explicit ranges with no-resolve: deterministic, with no
 * dependency on what the geo database calls private (the R1c decision, kept).
 */
const CLASH_PRIVATE = [
  'IP-CIDR,10.0.0.0/8',
  'IP-CIDR,172.16.0.0/12',
  'IP-CIDR,192.168.0.0/16',
  'IP-CIDR,127.0.0.0/8',
  'IP-CIDR,169.254.0.0/16',
  'IP-CIDR6,fc00::/7',
  'IP-CIDR6,fe80::/10',
  'IP-CIDR6,::1/128',
];

/** One mihomo rule body (without the target) per matcher, and whether the
 *  line takes `no-resolve` (a literal range does; GEOIP is the resolve-then-
 *  decide fallback and does not). */
function clashMatcher(m: string): { body: string; noResolve: boolean }[] {
  if (m === 'geoip:private') return CLASH_PRIVATE.map((body) => ({ body, noResolve: true }));
  if (m.startsWith('geosite:')) return [{ body: `GEOSITE,${m.slice(8)}`, noResolve: false }];
  if (m.startsWith('geoip:')) return [{ body: `GEOIP,${m.slice(6).toUpperCase()}`, noResolve: false }];
  if (m.startsWith('full:')) return [{ body: `DOMAIN,${m.slice(5)}`, noResolve: false }];
  if (m.startsWith('keyword:')) return [{ body: `DOMAIN-KEYWORD,${m.slice(8)}`, noResolve: false }];
  if (m.startsWith('regexp:')) return [{ body: `DOMAIN-REGEX,${m.slice(7)}`, noResolve: false }];
  if (m.startsWith('domain:')) return [{ body: `DOMAIN-SUFFIX,${m.slice(7)}`, noResolve: false }];
  if (m.startsWith('port:')) return [{ body: `DST-PORT,${port(m)}`, noResolve: false }];
  const [addr, bits] = m.split('/');
  const family = isIP(addr!);
  if (family !== 0) {
    const cidr = `${addr}/${bits ?? (family === 4 ? '32' : '128')}`;
    return [{ body: `${family === 4 ? 'IP-CIDR' : 'IP-CIDR6'},${cidr}`, noResolve: true }];
  }
  return [{ body: `DOMAIN-SUFFIX,${m}`, noResolve: false }];
}

/** mihomo `rules:` lines. `proxyGroup` null = no proxy in the config, so a
 *  `proxy` rule is left out (the MATCH line is DIRECT then). */
export function clashDeviceRuleLines(rules: readonly DeviceRouteRule[], proxyGroup: string | null): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const target = r.action === 'direct' ? 'DIRECT' : r.action === 'block' ? 'REJECT' : proxyGroup;
    if (!target) continue;
    for (const m of r.match) {
      for (const { body, noResolve } of clashMatcher(m)) {
        out.push(`  - ${body},${target}${noResolve ? ',no-resolve' : ''}`);
      }
    }
  }
  return out;
}

/** Whether the rules name the geo databases, which mihomo has to fetch. */
export function clashNeedsGeo(rules: readonly DeviceRouteRule[]): boolean {
  return rules.some((r) => r.match.some((m) => (m.startsWith('geosite:') || m.startsWith('geoip:')) && m !== 'geoip:private'));
}

// ---------------------------------------------------------------- sing-box

/**
 * sing-box 1.12 has no geosite:/geoip: of its own; a geo name is a remote
 * rule-set from the SagerNet repositories, the source the built-in presets
 * have always used, under the name pattern of those repositories.
 */
function singboxRuleSet(m: string): Record<string, unknown> {
  if (m.startsWith('geosite:')) {
    const tag = `geosite-${m.slice(8).toLowerCase()}`;
    return { type: 'remote', tag, format: 'binary', url: `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/${tag}.srs` };
  }
  const tag = `geoip-${m.slice(6).toLowerCase()}`;
  return { type: 'remote', tag, format: 'binary', url: `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/${tag}.srs` };
}

/**
 * sing-box `route.rules` and the `route.rule_set` they name. Consecutive rules
 * with one action are one group (first match wins, the same target either
 * way), and a group is written as: the private ranges, then its rule-sets,
 * then its inline domains, addresses and ports, each its own rule since
 * sing-box ANDs fields of different kinds within one rule. `proxyOutbound`
 * null = no proxy, a `proxy` group is left out.
 */
export function singboxDeviceRoute(
  rules: readonly DeviceRouteRule[],
  proxyOutbound: string | null,
): { rules: Record<string, unknown>[]; ruleSets: Record<string, unknown>[] } {
  const groups: { action: DeviceRouteRule['action']; match: string[] }[] = [];
  for (const r of rules) {
    const last = groups[groups.length - 1];
    if (last && last.action === r.action) last.match.push(...r.match);
    else groups.push({ action: r.action, match: [...r.match] });
  }

  const out: Record<string, unknown>[] = [];
  const sets = new Map<string, Record<string, unknown>>();
  for (const g of groups) {
    const action =
      g.action === 'block'
        ? { action: 'reject' }
        : g.action === 'direct'
          ? { action: 'route', outbound: 'direct' }
          : proxyOutbound
            ? { action: 'route', outbound: proxyOutbound }
            : null;
    if (!action) continue;
    const geo: string[] = [];
    const inline = { domain: [] as string[], domain_suffix: [] as string[], domain_keyword: [] as string[], domain_regex: [] as string[] };
    const cidr: string[] = [];
    const ports: number[] = [];
    const ranges: string[] = [];
    let isPrivate = false;
    for (const m of g.match) {
      if (m === 'geoip:private') isPrivate = true;
      else if (m.startsWith('geosite:') || m.startsWith('geoip:')) {
        const rs = singboxRuleSet(m);
        sets.set(rs.tag as string, rs);
        if (!geo.includes(rs.tag as string)) geo.push(rs.tag as string);
      } else if (m.startsWith('full:')) inline.domain.push(m.slice(5));
      else if (m.startsWith('keyword:')) inline.domain_keyword.push(m.slice(8));
      else if (m.startsWith('regexp:')) inline.domain_regex.push(m.slice(7));
      else if (m.startsWith('domain:')) inline.domain_suffix.push(m.slice(7));
      else if (m.startsWith('port:')) {
        const [lo, hi] = port(m).split('-');
        if (hi === undefined) ports.push(Number(lo));
        else ranges.push(`${lo}:${hi}`);
      } else if (isIP(m.split('/')[0]!) !== 0) cidr.push(m.includes('/') ? m : `${m}/${isIP(m) === 4 ? 32 : 128}`);
      else inline.domain_suffix.push(m);
    }
    if (isPrivate) out.push({ ip_is_private: true, ...action });
    if (geo.length) out.push({ rule_set: geo, ...action });
    const names = Object.fromEntries(Object.entries(inline).filter(([, v]) => v.length > 0));
    if (Object.keys(names).length) out.push({ ...names, ...action });
    if (cidr.length) out.push({ ip_cidr: cidr, ...action });
    if (ports.length) out.push({ port: ports, ...action });
    if (ranges.length) out.push({ port_range: ranges, ...action });
  }
  return { rules: out, ruleSets: [...sets.values()] };
}
