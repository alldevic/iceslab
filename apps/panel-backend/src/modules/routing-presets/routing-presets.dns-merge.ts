import { parseDnsServer, type DnsCfg, type DnsServer } from '@iceslab/shared';
import { xrayDnsRules } from '../subscription/subscription.device-rules.js';

/**
 * 19.10: what the DNS rules of presets become on a node, and when two of them
 * disagree. Pure: no database, so the cases are plain arrays.
 *
 * The node's DNS is one for all its clients (it re-resolves the names it
 * sniffs from the connection, m19-01 finding 3), so a rule of one preset acts
 * for everybody who goes through the node. Hence two presets on one node must
 * not give one name two servers.
 */

/** The limits of DnsSchema (nodes.schemas.ts): the agent has none of its own. */
export const NODE_DNS_MAX_SERVERS = 16;
export const NODE_DNS_MAX_DOMAINS = 64;

export interface CarriedRule {
  match: string[];
  server: string;
}

/** What the node stores per source: `presetId` null is the panel-wide rules. */
export interface StoredPresetDns {
  presetId: string | null;
  rules: CarriedRule[];
}

/** A source with its name, for a refusal that names it. */
export interface NamedDnsSource {
  presetId: string | null;
  name: string;
  rules: readonly CarriedRule[];
}

/**
 * Whether the node's core runs the server kind. Today the DNS of a node is
 * xray's, which has no DoT: `tls://` is taken for a host name and never
 * answers (m19-01). Such a rule is not carried; the preset screen says so (19.12).
 */
export function carriesRule(rule: { server: string }): boolean {
  const s = parseDnsServer(rule.server);
  return s !== null && s.kind !== 'tls';
}

/** A name as one comparable string: a bare name is `domain:NAME`, case folded. */
export function normalizeDnsName(m: string): string {
  const n = m.trim().toLowerCase();
  return /^(geosite|domain|full):/.test(n) ? n : `domain:${n}`;
}

/** A server as one comparable string: `1.1.1.1` and `1.1.1.1:53` are one server. */
export function normalizeDnsServer(raw: string): string {
  const s = parseDnsServer(raw);
  return s ? `${s.kind}://${s.host.toLowerCase()}:${s.port}${s.path}` : raw;
}

export interface DnsConflict {
  /** The name as the first rule wrote it. */
  domain: string;
  a: { presetId: string | null; name: string; server: string };
  b: { presetId: string | null; name: string; server: string };
}

/**
 * The first name two different sources give different servers, or null. A
 * source repeating itself is not a conflict (the first rule of a preset wins,
 * as in the subscription). `domain:x` and a bare `x` are one name; `geosite:`
 * meets only the same tag, never a single name inside it. With `focus`, only a
 * pair that has the source `focus` in it counts: a save is refused for what it
 * adds, not for a disagreement it did not make. `undefined` = any pair.
 */
export function findDnsConflict(sources: readonly NamedDnsSource[], focus?: { presetId: string | null }): DnsConflict | null {
  const seen = new Map<string, { source: NamedDnsSource; server: string; raw: string; written: string }[]>();
  for (const source of sources) {
    for (const rule of source.rules) {
      if (!carriesRule(rule)) continue;
      const server = normalizeDnsServer(rule.server);
      for (const written of rule.match) {
        const key = normalizeDnsName(written);
        const earlier = seen.get(key) ?? [];
        for (const e of earlier) {
          if (e.source.presetId === source.presetId || e.server === server) continue;
          if (focus && focus.presetId !== source.presetId && focus.presetId !== e.source.presetId) continue;
          return {
            domain: e.written,
            a: { presetId: e.source.presetId, name: e.source.name, server: e.raw },
            b: { presetId: source.presetId, name: source.name, server: rule.server },
          };
        }
        earlier.push({ source, server, raw: rule.server, written });
        seen.set(key, earlier);
      }
    }
  }
  return null;
}

/** A rule not carried because a source ahead of it names the same name with another server (19.11). */
export interface DroppedDnsRule {
  presetId: string | null;
  /** The source that keeps the name: a preset id, null for the panel-wide rules. */
  otherPresetId: string | null;
  domain: string;
  server: string;
}

/**
 * What a node carries when two sources disagree and nobody can be refused (the
 * disagreement came from a change of squads or bindings, not from a save). The
 * sources come in priority order, the one that was on the node first at the
 * head; a rule that names a name an earlier source gave another server is not
 * carried, whole, and is reported. A source repeating itself is no conflict.
 * Pure: same sources, same answer, so a recompute that changes nothing is silent.
 */
export function resolveDnsConflicts(sources: readonly NamedDnsSource[]): { kept: NamedDnsSource[]; dropped: DroppedDnsRule[] } {
  const seen = new Map<string, { presetId: string | null; server: string }[]>();
  const dropped: DroppedDnsRule[] = [];
  const kept = sources.map((source) => {
    const rules: CarriedRule[] = [];
    for (const rule of source.rules) {
      if (!carriesRule(rule)) {
        rules.push(rule);
        continue;
      }
      const server = normalizeDnsServer(rule.server);
      let clash: { domain: string; with: string | null } | null = null;
      for (const written of rule.match) {
        const other = (seen.get(normalizeDnsName(written)) ?? []).find((e) => e.presetId !== source.presetId && e.server !== server);
        if (other) {
          clash = { domain: written, with: other.presetId };
          break;
        }
      }
      if (clash) {
        dropped.push({ presetId: source.presetId, otherPresetId: clash.with, domain: clash.domain, server: rule.server });
        continue;
      }
      for (const written of rule.match) {
        const key = normalizeDnsName(written);
        seen.set(key, [...(seen.get(key) ?? []), { presetId: source.presetId, server }]);
      }
      rules.push(rule);
    }
    return { ...source, rules };
  });
  return { kept, dropped };
}

/**
 * The node's `dns` for a push: the manual one first (its servers keep their
 * place, so a manual server wins over a carried one for the same name), then
 * the carried servers, one per distinct server with all its names, each
 * `skipFallback` (a name given to a server stays with it). The manual
 * `queryStrategy` and `disableCache` stay. Nothing carried -> the manual `dns`
 * itself, byte for byte (undefined for none), so a node no preset reaches gets
 * the request it always got. More than 64 names for one server go in more
 * entries of the same address.
 */
export function mergeNodeDns(manual: DnsCfg | null | undefined, carried: readonly StoredPresetDns[] | null | undefined): DnsCfg | undefined {
  const byAddress = new Map<string, string[]>();
  for (const src of carried ?? []) {
    for (const rule of src.rules) {
      if (!carriesRule(rule)) continue;
      const entry = xrayDnsRules([{ match: rule.match, server: rule.server, note: '' }]).servers[0];
      if (!entry) continue;
      const names = byAddress.get(entry.address as string) ?? [];
      for (const d of entry.domains as string[]) if (!names.includes(d)) names.push(d);
      byAddress.set(entry.address as string, names);
    }
  }
  const added: DnsServer[] = [];
  for (const [address, names] of byAddress) {
    for (let i = 0; i < names.length; i += NODE_DNS_MAX_DOMAINS) {
      added.push({ address, domains: names.slice(i, i + NODE_DNS_MAX_DOMAINS), skipFallback: true });
    }
  }
  if (added.length === 0) return manual ?? undefined;
  return { ...(manual ?? {}), servers: [...(manual?.servers ?? []), ...added] };
}
