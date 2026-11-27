import { MAX_DNS_RULES, MAX_DNS_RULE_NAMES, parseDnsServer, type DnsRule } from '@iceslab/shared';
import { splitMatch } from '@/contours/traffic/lib/routeRules';
import type { RoutingPresetRefusal } from '@/lib/domain/routePolicies';

/**
 * Stage 19: the editor's side of "names -> DNS server" rules. The row is kept
 * as the text the operator typed (a space typed after a name must stay), and
 * becomes a DnsRule only when it is sent. The checks are the API's, run before
 * the send: the same server parse (packages/shared), the same name forms.
 */
export interface DnsRuleDraft {
  match: string;
  server: string;
  note: string;
}

export function dnsDrafts(rules: readonly DnsRule[]): DnsRuleDraft[] {
  return rules.map((r) => ({ match: r.match.join(' '), server: r.server, note: r.note }));
}

function isBlank(d: DnsRuleDraft): boolean {
  return d.match.trim() === '' && d.server.trim() === '' && d.note.trim() === '';
}

/** What a save sends: rows as written, rows with nothing in them left out. */
export function dnsRulesOf(drafts: readonly DnsRuleDraft[]): DnsRule[] {
  return drafts.filter((d) => !isBlank(d)).map((d) => ({ match: splitMatch(d.match), server: d.server.trim(), note: d.note.trim() }));
}

const HOSTNAME = /^[A-Za-z0-9_*]([A-Za-z0-9_*.-]*[A-Za-z0-9_])?$/;

/**
 * A name a DNS rule can carry: geosite:TAG, domain:NAME, full:NAME or a bare
 * host name. keyword:, regexp:, ext: sets, addresses and ports are refused,
 * as by the API. Whether a geosite tag exists is the API's to say.
 */
export function isDnsName(m: string): boolean {
  for (const prefix of ['geosite:', 'domain:', 'full:']) {
    if (m.startsWith(prefix)) return /^\S+$/.test(m.slice(prefix.length));
  }
  if (/^[\d.]+$/.test(m)) return false;
  return HOSTNAME.test(m);
}

export interface DnsRowProblem {
  badNames: string[];
  badServer: boolean;
  /** Something is typed in the row, but not both the names and the server. */
  incomplete: boolean;
  tooManyNames: boolean;
}

export interface DnsCheck {
  rows: DnsRowProblem[];
  tooManyRules: boolean;
  /** Any problem at all: the save waits. */
  blocked: boolean;
}

export function checkDnsDrafts(drafts: readonly DnsRuleDraft[]): DnsCheck {
  const rows = drafts.map((d): DnsRowProblem => {
    const names = splitMatch(d.match);
    const blank = isBlank(d);
    return {
      badNames: names.filter((n) => !isDnsName(n)),
      badServer: d.server.trim() !== '' && parseDnsServer(d.server.trim()) === null,
      incomplete: !blank && (names.length === 0 || d.server.trim() === ''),
      tooManyNames: names.length > MAX_DNS_RULE_NAMES,
    };
  });
  const tooManyRules = drafts.filter((d) => !isBlank(d)).length > MAX_DNS_RULES;
  const blocked = tooManyRules || rows.some((r) => r.badNames.length > 0 || r.badServer || r.incomplete || r.tooManyNames);
  return { rows, tooManyRules, blocked };
}

/** What the API refused on the last save, to mark at the rows. */
export interface DnsRefused {
  names: string[];
  servers: string[];
}

export const NO_DNS_REFUSED: DnsRefused = { names: [], servers: [] };

/**
 * The entries of a refusal that belong to DNS rules. A geo tag the panel does
 * not have is read as a DNS name too: a preset's device rules mark it in their
 * own rows, a name that is in neither list marks nothing.
 */
export function dnsRefusedOf(r: RoutingPresetRefusal | null): DnsRefused {
  if (!r) return NO_DNS_REFUSED;
  if (r.code === 'ROUTING_PRESET_DNS_MATCH_INVALID' || r.code === 'ROUTING_PRESET_GEO_TAG_UNKNOWN') return { names: r.entries, servers: [] };
  if (r.code === 'ROUTING_PRESET_DNS_SERVER_INVALID') return { names: [], servers: r.entries };
  return NO_DNS_REFUSED;
}
