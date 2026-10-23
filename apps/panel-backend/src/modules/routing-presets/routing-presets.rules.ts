import { z } from 'zod';
import { GEO_BUILTIN_NAMES, type RoutingPresetId } from '@iceslab/shared';
import { classifyPolicyEntry } from '../cascades/policy-entries.js';
import { parseGeoRef } from '../geo-sets/geo-names.js';
import { setTagNames } from '../geo-sets/geo-sets.service.js';

/**
 * A-229: the rules of a device routing preset, the set written into the
 * client's own config.
 *
 * One rule = an ordered list of matchers and what to do with a match. First
 * match wins. A device can only go direct, block or tunnel: WARP is a node
 * egress and has no meaning on a phone, so it is refused here rather than
 * dropped later.
 */

export const DEVICE_ROUTE_ACTIONS = ['direct', 'block', 'proxy'] as const;
export type DeviceRouteAction = (typeof DEVICE_ROUTE_ACTIONS)[number];

export interface DeviceRouteRule {
  match: string[];
  action: DeviceRouteAction;
  note: string;
}

/**
 * The built-in presets in the same shape. They are what the three formats
 * render today (xrayjson.ts RU_SPLIT_RULES / CN_SPLIT_RULES and the Clash and
 * sing-box twins), written once as data so the list endpoint can show them
 * and the screen stops holding its own copy.
 */
export const BUILTIN_PRESET_RULES: Record<RoutingPresetId, readonly DeviceRouteRule[]> = {
  'proxy-all': [],
  'ru-split': [
    { match: ['geosite:category-ads-all'], action: 'block', note: '' },
    { match: ['geosite:category-ru', 'geosite:category-gov-ru'], action: 'direct', note: '' },
    { match: ['geoip:private', 'geoip:ru'], action: 'direct', note: '' },
  ],
  'cn-split': [
    { match: ['geosite:category-ads-all'], action: 'block', note: '' },
    { match: ['geosite:cn'], action: 'direct', note: '' },
    { match: ['geoip:private', 'geoip:cn'], action: 'direct', note: '' },
  ],
};

export const MAX_PRESET_RULES = 256;
export const MAX_RULE_MATCHERS = 256;

export const DeviceRouteRuleSchema = z.object({
  match: z.array(z.string().trim().min(1).max(253)).min(1, 'a rule needs at least one matcher').max(MAX_RULE_MATCHERS),
  action: z.enum(DEVICE_ROUTE_ACTIONS, {
    error: 'a device rule goes direct, block or proxy; warp is a node egress and has no meaning on a device',
  }),
  note: z.string().max(200).default(''),
});

const PORT = /^port:(\d{1,5})(?:-(\d{1,5}))?$/;

/** `port:N` or `port:N-M`, 1..65535, N <= M. */
export function isPortMatcher(m: string): boolean {
  const p = PORT.exec(m);
  if (!p) return false;
  const lo = Number(p[1]);
  const hi = p[2] === undefined ? lo : Number(p[2]);
  return lo >= 1 && hi <= 65535 && lo <= hi;
}

export type MatcherKind = 'domain' | 'ip' | 'port';

/**
 * What a matcher is, or null for one a device rule cannot carry. The names and
 * addresses are the node policies' grammar (classifyPolicyEntry), less `ext:`:
 * an operator's set is a file on the NODES, and a client has no such file, so
 * a device rule naming one would match nothing.
 */
export function matcherKind(m: string): MatcherKind | null {
  if (isPortMatcher(m)) return 'port';
  if (m.startsWith('ext:') || m.startsWith('ext-domain:') || m.startsWith('ext-ip:')) return null;
  return classifyPolicyEntry(m);
}

export class RoutingPresetRulesError extends Error {
  constructor(
    public readonly code: 'ROUTING_PRESET_ENTRY_UNKNOWN' | 'ROUTING_PRESET_GEO_TAG_UNKNOWN',
    message: string,
    public readonly entries: string[],
  ) {
    super(message);
    this.name = 'RoutingPresetRulesError';
  }
}

/**
 * The checks a schema cannot make: every matcher is one a device rule can
 * carry, and every `geosite:`/`geoip:` names a tag the panel's built-in set
 * has. A set with no verified version yet is an unknown list and refuses
 * nothing (an incomplete fact is not a fact).
 */
export async function checkRules(rules: readonly { match: string[] }[]): Promise<void> {
  const all = [...new Set(rules.flatMap((r) => r.match))];
  const unknown = all.filter((m) => matcherKind(m) === null);
  if (unknown.length > 0) {
    throw new RoutingPresetRulesError(
      'ROUTING_PRESET_ENTRY_UNKNOWN',
      `not a matcher a device rule can carry: ${unknown.map((e) => JSON.stringify(e)).join(', ')}. ` +
        'Names: geosite:TAG, domain:NAME, full:NAME, keyword:WORD, regexp:PATTERN, a hostname. ' +
        'Addresses: geoip:TAG, an IP or a CIDR. Ports: port:N or port:N-M. ' +
        'ext:SET:TAG is not here: those sets live on the nodes, a device does not have them.',
      unknown,
    );
  }
  const missing: string[] = [];
  for (const kind of ['geosite', 'geoip'] as const) {
    const refs = all
      .filter((m) => m.startsWith(`${kind}:`))
      .map((m) => parseGeoRef(m, kind === 'geoip' ? 'ip' : 'domain'))
      .filter((r) => r !== null);
    if (refs.length === 0) continue;
    const have = await setTagNames(GEO_BUILTIN_NAMES[kind]);
    if (!have) continue;
    for (const r of refs) if (!have.has(r.baseTag)) missing.push(r.entry);
  }
  if (missing.length > 0) {
    throw new RoutingPresetRulesError(
      'ROUTING_PRESET_GEO_TAG_UNKNOWN',
      `the panel's built-in geo sets have no such tag: ${missing.map((e) => JSON.stringify(e)).join(', ')}. ` +
        'Pick a tag from the set (Geo sets screen); a misspelled tag matches nothing on the device.',
      missing,
    );
  }
}
