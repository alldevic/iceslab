import { z } from 'zod';
import { MAX_DNS_RULES, MAX_DNS_RULE_NAMES, parseDnsServer, type DnsRule } from '@iceslab/shared';
import { classifyPolicyEntry } from '../cascades/policy-entries.js';

/**
 * Stage 19: the shape and the sync checks of "names -> DNS server" rules, the
 * operator's own preset's `dnsRules` and the panel-wide `subscriptionDnsRules`.
 * One schema for both. No database here: the settings schema loads it without
 * prisma. The geo tag check, which reads the geo sets, is in
 * routing-presets.rules.ts (checkDnsRules).
 */

export { MAX_DNS_RULES, MAX_DNS_RULE_NAMES, type DnsRule };

export const DnsRuleSchema = z.object({
  match: z
    .array(z.string().trim().min(1).max(253))
    .min(1, 'a rule needs at least one name')
    .max(MAX_DNS_RULE_NAMES),
  server: z.string().trim().min(1).max(300),
  note: z.string().max(200).default(''),
});

export const DnsRulesSchema = z.array(DnsRuleSchema).max(MAX_DNS_RULES);

/**
 * A name a DNS rule can carry: geosite:TAG, domain:NAME, full:NAME or a bare
 * name. keyword:, regexp:, an address, a port and ext: are what the clients'
 * DNS sections cannot match on, so they are refused rather than dropped later.
 */
export function isDnsMatchName(m: string): boolean {
  if (m.startsWith('keyword:') || m.startsWith('regexp:')) return false;
  if (m.startsWith('ext:') || m.startsWith('ext-domain:') || m.startsWith('ext-ip:')) return false;
  return classifyPolicyEntry(m) === 'domain';
}

export type DnsRuleProblem =
  | { code: 'ROUTING_PRESET_DNS_MATCH_INVALID'; message: string; entries: string[] }
  | { code: 'ROUTING_PRESET_DNS_SERVER_INVALID'; message: string; entries: string[] };

/** The first thing wrong with the rules that needs no database, or null. */
export function dnsRuleProblem(rules: readonly { match: readonly string[]; server: string }[]): DnsRuleProblem | null {
  const names = [...new Set(rules.flatMap((r) => r.match))].filter((m) => !isDnsMatchName(m));
  if (names.length > 0) {
    return {
      code: 'ROUTING_PRESET_DNS_MATCH_INVALID',
      message:
        `not a name a DNS rule can carry: ${names.map((e) => JSON.stringify(e)).join(', ')}. ` +
        'Only geosite:TAG, domain:NAME, full:NAME or a bare name; keyword:, regexp:, addresses, ports and ext: sets are not matched by a DNS server rule.',
      entries: names,
    };
  }
  const servers = [...new Set(rules.map((r) => r.server))].filter((s) => parseDnsServer(s) === null);
  if (servers.length > 0) {
    return {
      code: 'ROUTING_PRESET_DNS_SERVER_INVALID',
      message:
        `not a DNS server: ${servers.map((e) => JSON.stringify(e)).join(', ')}. ` +
        'One of: an IP (UDP/53), tcp://IP[:port], tls://HOST[:port], https://HOST[:port]/path. UDP and TCP take an IP, not a name.',
      entries: servers,
    };
  }
  return null;
}
