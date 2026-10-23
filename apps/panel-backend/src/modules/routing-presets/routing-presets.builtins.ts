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
