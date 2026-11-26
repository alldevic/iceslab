import type { RoutingPresetId } from '@iceslab/shared';

/**
 * A-229: the shape of a device routing preset's rules, and the three built-in
 * presets in it. Pure, no database: the format renderers import it, and they
 * are pure themselves (routing-presets.rules.ts is the half that checks
 * against the tables).
 *
 * One rule = an ordered list of matchers and what to do with a match. First
 * match wins. A device can only go direct, block or tunnel: WARP is a node
 * egress and has no meaning on a phone.
 */

export const DEVICE_ROUTE_ACTIONS = ['direct', 'block', 'proxy'] as const;
export type DeviceRouteAction = (typeof DEVICE_ROUTE_ACTIONS)[number];

export interface DeviceRouteRule {
  match: string[];
  action: DeviceRouteAction;
  note: string;
}

/**
 * The built-in presets, the one copy: xray-json, Clash and sing-box render
 * them from here (subscription/subscription.device-rules.ts), the list endpoint
 * shows them, and the screen stops holding its own.
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

/** The geosite tag of the ad rule: the one category an embedded split preset drops (milestone 12.5). */
export const ADS_GEOSITE = 'geosite:category-ads-all';

/**
 * The geo categories a built-in split preset names, ads left out: what a
 * document would have to carry itself to name none (milestone 12.5). `private`
 * is not one: it is written as literals. Empty for proxy-all.
 */
export function splitGeoTags(preset: RoutingPresetId): { geosite: string[]; geoip: string[] } {
  const geosite: string[] = [];
  const geoip: string[] = [];
  for (const r of BUILTIN_PRESET_RULES[preset]) {
    for (const m of r.match) {
      if (m === ADS_GEOSITE) continue;
      if (m.startsWith('geosite:')) geosite.push(m.slice(8));
      else if (m.startsWith('geoip:') && m !== 'geoip:private') geoip.push(m.slice(6));
    }
  }
  return { geosite, geoip };
}
