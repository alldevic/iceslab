import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESET_RULES } from '../../routing-presets/routing-presets.builtins.js';
import { clashCanUsePanelGeo } from '../subscription.device-rules.js';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import type { SelfHostedGeo } from '../../geo-sets/geo-self-host.js';

/**
 * The enabled flag, on the built-in presets (milestone 10.5): the golden files
 * hold the base (flag off) and stay as they are; here the same cases are asked
 * with a panel that has every tag, and only the geo addresses may differ.
 */
const ep = {
  nodeId: 'n1', port: 443, protocol: 'hysteria', nodeName: 'eu-1', host: 'eu.example.com', uri: '', password: 'pw',
} as unknown as SubscriptionEndpoint;

const PRESETS = ['proxy-all', 'ru-split', 'cn-split'] as const;
const names = (kind: 'geosite:' | 'geoip:') =>
  new Set(Object.values(BUILTIN_PRESET_RULES).flatMap((rs) => rs.flatMap((r) => r.match)).filter((m) => m.startsWith(kind) && m !== 'geoip:private').map((m) => m.slice(kind.length).toLowerCase()));
const FULL: SelfHostedGeo = { baseUrl: 'https://p.example.com/geo/T', tags: { geosite: names('geosite:'), geoip: names('geoip:') }, srs: true };

describe.each(PRESETS)('preset %s, a panel that has every tag', (routingPreset) => {
  it('clash: flag off is the base; on, only the geox-url block differs', () => {
    const base = buildClashYaml([ep], { routingPreset });
    expect(buildClashYaml([ep], { routingPreset, geo: null })).toBe(base);
    const on = buildClashYaml([ep], { routingPreset, geo: FULL });
    if (routingPreset === 'proxy-all') return expect(on).toBe(base);
    const cut = (t: string) => t.replace(/geodata-mode[\s\S]*?\n\n/, '').replace(/geo-auto-update[\s\S]*?\n\n/, '');
    expect(on).toContain('/geo/T/geosite.dat');
    expect(cut(on)).toBe(cut(base));
  });

  it('sing-box: flag off is the base; on, only the rule-set urls differ', () => {
    const base = buildSingboxJson([ep], { routingPreset });
    expect(buildSingboxJson([ep], { routingPreset, geo: null })).toBe(base);
    const on = buildSingboxJson([ep], { routingPreset, geo: FULL });
    const unurl = (t: string) => t.replace(/"url": "[^"]*"/g, '"url": ""');
    expect(unurl(on)).toBe(unurl(base));
    if (routingPreset !== 'proxy-all') expect(on).toContain('https://p.example.com/geo/T/geosite-');
  });
});

describe('clashCanUsePanelGeo', () => {
  const rules = (...match: string[]) => [{ action: 'direct' as const, match }];
  it('geoip:private is ranges, it needs no tag; a rule with no geo name needs no set', () => {
    const empty: SelfHostedGeo = { baseUrl: 'x', tags: { geosite: new Set(), geoip: new Set() }, srs: false };
    expect(clashCanUsePanelGeo(rules('geoip:private', 'example.com'), empty)).toBe(true);
    expect(clashCanUsePanelGeo(rules('geosite:cn'), empty)).toBe(false);
  });
  it('tags are compared as the rule spells them: lower case, without @attr', () => {
    const g: SelfHostedGeo = { baseUrl: 'x', tags: { geosite: new Set(['google']), geoip: new Set(['cn']) }, srs: true };
    expect(clashCanUsePanelGeo(rules('geosite:Google@CN', 'geoip:CN'), g)).toBe(true);
    expect(clashCanUsePanelGeo(rules('geosite:google', 'geoip:ru'), g)).toBe(false);
  });
  it('null, or a set that is not served, is no', () => {
    expect(clashCanUsePanelGeo(rules('geoip:private'), null)).toBe(false);
    expect(clashCanUsePanelGeo(rules('geoip:private'), { baseUrl: 'x', tags: { geosite: new Set(), geoip: null }, srs: true })).toBe(false);
  });
});
