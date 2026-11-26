import { describe, expect, it } from 'vitest';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson, buildXrayJsonArray } from './xrayjson.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import type { SingboxExtRef } from '../../geo-sets/geo-ext-lists.js';

/**
 * Milestone 10.6: what the formats do with the operator's lists once the route
 * has resolved the `ext:` links (what the route leaves out never gets here, see
 * geo-ext-lists.test.ts). The expanded entries are xray-prefixed strings.
 */
const xrayEp = {
  protocol: 'xray', nodeName: 'eu-1', host: 'n1.example.com', port: 443, uuid: '11111111-2222-3333-4444-555555555555',
  publicKey: 'pubkey-base64url', shortId: 'abc123', sni: 'www.cloudflare.com', flow: 'xtls-rprx-vision', fingerprint: 'chrome', network: 'raw', uri: 'vless://...',
} as unknown as SubscriptionEndpoint;
const hyEp = { protocol: 'hysteria', nodeName: 'eu-1', host: 'n1.example.com', port: 443, password: 'pw', uri: 'hysteria2://...' } as unknown as SubscriptionEndpoint;

const expanded = { block: [], direct: ['domain:a.example.ru', 'full:www.b.example.ru', 'keyword:kw', 'regexp:^r\\d+\\.example$'], proxy: ['domain:p.example'] };

describe('expanded lists', () => {
  it('clash: each entry has the rule type of its prefix, buckets in the usual order', () => {
    const out = buildClashYaml([xrayEp], { customDomainLists: { ...expanded, block: ['domain:ads.example'] } });
    const rules = out.slice(out.indexOf('rules:')).split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.trim());
    expect(rules.slice(0, 6)).toEqual([
      '- DOMAIN-SUFFIX,ads.example,REJECT',
      '- DOMAIN-SUFFIX,a.example.ru,DIRECT',
      '- DOMAIN,www.b.example.ru,DIRECT',
      '- DOMAIN-KEYWORD,kw,DIRECT',
      '- DOMAIN-REGEX,^r\\d+\\.example$,DIRECT',
      expect.stringMatching(/^- DOMAIN-SUFFIX,p\.example,/),
    ]);
  });

  it('xray-json: both documents carry the expanded entries in the direct rule', () => {
    const rule = (cfg: { routing: { rules: { domain?: string[]; outboundTag?: string }[] } }) =>
      cfg.routing.rules.find((r) => r.outboundTag === 'direct' && r.domain?.includes('full:www.b.example.ru'));
    expect(rule(JSON.parse(buildXrayJson([xrayEp], { customDomainLists: expanded })))!.domain).toEqual(expanded.direct);
    const arr = JSON.parse(buildXrayJsonArray([xrayEp], { customDomainLists: expanded })) as Parameters<typeof rule>[0][];
    expect(rule(arr[0]!)!.domain).toEqual(expanded.direct);
  });
});

describe('sing-box extRefs', () => {
  const refs: SingboxExtRef[] = [
    { bucket: 'block', tag: 'iceslab-m.ads', url: 'https://p.example.com/geo/T/iceslab-m.ads.srs' },
    { bucket: 'direct', tag: 'iceslab-m.ru', url: 'https://p.example.com/geo/T/iceslab-m.ru.srs' },
    { bucket: 'proxy', tag: 'geosite-x', url: 'https://p.example.com/geo/T/geosite-x.srs' },
  ];
  const cfg = (o: Parameters<typeof buildSingboxJson>[1]) =>
    JSON.parse(buildSingboxJson([hyEp], o)) as { route: { rules: Record<string, unknown>[]; rule_set: Record<string, unknown>[]; final: string } };

  it('a remote rule-set of the panel and a rule to the list\'s exit each, ahead of the preset', () => {
    const r = cfg({ routingPreset: 'ru-split', extRefs: refs }).route;
    expect(r.rules.slice(0, 3)).toEqual([
      { rule_set: ['iceslab-m.ads'], action: 'reject' },
      { rule_set: ['iceslab-m.ru'], action: 'route', outbound: 'direct' },
      { rule_set: ['geosite-x'], action: 'route', outbound: r.final },
    ]);
    expect(r.rule_set).toContainEqual({ type: 'remote', tag: 'iceslab-m.ru', format: 'binary', url: refs[1]!.url });
    expect(r.rule_set.length).toBeGreaterThan(3);
  });

  it('under proxy-all the links are the only routing', () => {
    const r = cfg({ extRefs: refs }).route;
    expect(r.rules).toHaveLength(3);
    expect(r.rule_set.map((s) => s.tag)).toEqual(['iceslab-m.ads', 'iceslab-m.ru', 'geosite-x']);
  });

  it('a rule-set the preset also names is declared once', () => {
    const r = cfg({ routingPreset: 'ru-split', extRefs: [{ bucket: 'direct', tag: 'geosite-category-ru', url: 'https://p.example.com/geo/T/geosite-category-ru.srs' }] }).route;
    expect(r.rule_set.filter((s) => s.tag === 'geosite-category-ru')).toHaveLength(1);
  });

  it('no refs: the document is the base', () => {
    expect(buildSingboxJson([hyEp], { routingPreset: 'ru-split', extRefs: [] })).toBe(buildSingboxJson([hyEp], { routingPreset: 'ru-split' }));
  });

  it('a proxy link with no proxy is left out', () => {
    const r = JSON.parse(buildSingboxJson([], { extRefs: refs })) as { route: { rules: unknown[]; rule_set: { tag: string }[] } };
    expect(r.route.rule_set.map((s) => s.tag)).not.toContain('geosite-x');
  });
});
