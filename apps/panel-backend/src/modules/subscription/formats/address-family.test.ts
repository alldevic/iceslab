import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

/**
 * f12-19, f12-20: the address-family strategy of the split-DNS blocks is the
 * answer of one calculation (subscription.address-family.ts), the same for
 * xray-json and sing-box. The calculation is replaced here, so both outcomes
 * can be asked of both formats.
 */
const calc = vi.hoisted(() => ({ hasIpv6: false, seen: [] as unknown[] }));
vi.mock('../subscription.address-family.js', async (orig) => {
  const real = await orig<typeof import('../subscription.address-family.js')>();
  return {
    ...real,
    exitsHaveIpv6: (points: readonly SubscriptionEndpoint[]) => {
      calc.seen.push(points);
      return calc.hasIpv6;
    },
  };
});

const { buildXrayJson, buildXrayJsonArray } = await import('./xrayjson.js');
const { buildSingboxJson } = await import('./singbox.js');
const { exitsHaveIpv6 } = await vi.importActual<typeof import('../subscription.address-family.js')>(
  '../subscription.address-family.js',
);

const ep: SubscriptionEndpoint = {
  protocol: 'xray', nodeName: 'eu-1', host: 'n1.example.com', port: 443,
  uuid: '11111111-2222-3333-4444-555555555555', publicKey: 'pub', shortId: 'abc123', sni: 'www.cloudflare.com',
  flow: 'xtls-rprx-vision', fingerprint: 'chrome', uri: 'vless://...',
};

beforeEach(() => {
  calc.hasIpv6 = false;
  calc.seen = [];
});

describe('the calculation reads the flag on the points', () => {
  it('no point, or no flag on any, is no IPv6', () => {
    expect(exitsHaveIpv6([])).toBe(false);
    expect(exitsHaveIpv6([ep])).toBe(false);
    expect(exitsHaveIpv6([{ ...ep, exitHasIpv6: false }])).toBe(false);
  });

  it('at least one exit is enough, not all of them', () => {
    expect(exitsHaveIpv6([ep, { ...ep, exitHasIpv6: true }])).toBe(true);
  });
});

describe('xray-json queryStrategy follows the calculation', () => {
  it.each([
    [false, 'UseIPv4'],
    [true, 'UseIP'],
  ] as const)('exits have IPv6 = %s -> %s, in every split block', (has, want) => {
    calc.hasIpv6 = has;
    for (const preset of ['ru-split', 'cn-split'] as const) {
      expect(JSON.parse(buildXrayJson([ep], { routingPreset: preset })).dns.queryStrategy).toBe(want);
      for (const c of JSON.parse(buildXrayJsonArray([ep], { routingPreset: preset }))) {
        expect(c.dns.queryStrategy).toBe(want);
      }
    }
  });

  it('proxy-all and an own preset have no dns block to carry it', () => {
    expect(JSON.parse(buildXrayJson([ep], { routingPreset: 'proxy-all' })).dns).toBeUndefined();
    const own = [{ match: ['geosite:category-ru'], action: 'direct', note: '' }] as never;
    expect(JSON.parse(buildXrayJson([ep], { ownPresetRules: own })).dns).toBeUndefined();
  });

  it('the calculation is asked of the document\'s points', () => {
    buildXrayJson([ep], { routingPreset: 'ru-split' });
    expect(calc.seen[0]).toEqual([ep]);
  });
});

describe('sing-box dns.strategy follows the same calculation', () => {
  it.each([
    [false, 'prefer_ipv4'],
    [true, undefined],
  ] as const)('exits have IPv6 = %s -> %s', (has, want) => {
    calc.hasIpv6 = has;
    for (const preset of ['ru-split', 'cn-split'] as const) {
      const dns = JSON.parse(buildSingboxJson([ep], { routingPreset: preset })).dns;
      expect(dns.strategy).toBe(want);
      expect('strategy' in dns).toBe(want !== undefined);
    }
  });

  it('the calculation is asked of the document\'s points', () => {
    buildSingboxJson([ep], { routingPreset: 'cn-split' });
    expect(calc.seen[0]).toEqual([ep]);
  });
});
