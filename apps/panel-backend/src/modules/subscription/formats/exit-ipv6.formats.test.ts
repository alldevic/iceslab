import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { buildXrayJson, buildXrayJsonArray } from './xrayjson.js';
import { buildSingboxJson } from './singbox.js';
import { buildClashYaml } from './clash.js';
import { clashDnsLines } from '../subscription.address-family.js';

/**
 * 18.7, with the real calculation (address-family.test.ts replaces it): what the
 * formats write for documents whose exits do and do not have IPv6.
 */
const ep = (nodeName: string, exitHasIpv6?: boolean): SubscriptionEndpoint => ({
  protocol: 'xray', nodeName, nodeId: nodeName, host: `${nodeName}.example.com`, port: 443,
  uuid: '11111111-2222-3333-4444-555555555555', publicKey: 'pub', shortId: 'abc123', sni: 'www.cloudflare.com',
  flow: 'xtls-rprx-vision', fingerprint: 'chrome', network: 'raw', uri: 'vless://...',
  ...(exitHasIpv6 === undefined ? {} : { exitHasIpv6 }),
});
const none = [ep('a'), ep('b')];
const one = [ep('a'), ep('b', true)];

describe('xray-json', () => {
  it.each([
    ['no exit with IPv6', none, 'UseIPv4'],
    ['one of two', one, 'UseIP'],
  ] as const)('%s -> %s', (_n, eps, want) => {
    for (const preset of ['ru-split', 'cn-split'] as const) {
      expect(JSON.parse(buildXrayJson([...eps], { routingPreset: preset })).dns.queryStrategy).toBe(want);
      for (const c of JSON.parse(buildXrayJsonArray([...eps], { routingPreset: preset }))) {
        expect(c.dns.queryStrategy).toBe(want);
      }
    }
  });

  it('a template with its own dns is left as it is', () => {
    const frame = { dns: { servers: ['8.8.8.8'] }, outbounds: [], routing: { rules: [] } };
    const out = JSON.parse(buildXrayJson([...one], { routingPreset: 'ru-split', frame } as never));
    expect(out.dns).toEqual({ servers: ['8.8.8.8'] });
  });
});

describe('sing-box', () => {
  it('prefer_ipv4 without an exit with IPv6, the key left out with one', () => {
    expect(JSON.parse(buildSingboxJson([...none], { routingPreset: 'ru-split' })).dns.strategy).toBe('prefer_ipv4');
    expect('strategy' in JSON.parse(buildSingboxJson([...one], { routingPreset: 'ru-split' })).dns).toBe(false);
  });
});

describe('clash family', () => {
  const dnsOf = (eps: SubscriptionEndpoint[], preset: 'proxy-all' | 'ru-split' | 'cn-split', dialect?: 'mihomo' | 'stash' | 'clash-legacy') =>
    parseYaml(buildClashYaml(eps, { routingPreset: preset, ...(dialect ? { dialect } : {}) })).dns;

  it.each(['proxy-all', 'ru-split', 'cn-split'] as const)('%s: ipv6: true with an exit with IPv6, no key without', (preset) => {
    for (const dialect of ['mihomo', 'stash', 'clash-legacy'] as const) {
      expect(dnsOf([...one], preset, dialect).ipv6).toBe(true);
      expect('ipv6' in dnsOf([...none], preset, dialect)).toBe(false);
    }
  });

  it('without IPv6 the block is byte for byte the one it was', () => {
    const yes = buildClashYaml([...one], { routingPreset: 'ru-split' });
    expect(yes.replace('  ipv6: true\n', '')).toBe(buildClashYaml([...none], { routingPreset: 'ru-split' }));
  });

  it('clashDnsLines leaves lines it cannot place alone', () => {
    expect(clashDnsLines(['dns:', '  x: 1'], true)).toEqual(['dns:', '  x: 1']);
  });
});
