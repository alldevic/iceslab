import { describe, expect, it } from 'vitest';
import { routingPresetRefusal } from '@/lib/domain/routePolicies';
import { checkDnsDrafts, dnsDrafts, dnsRefusedOf, dnsRulesOf, isDnsName, NO_DNS_REFUSED } from '@/contours/traffic/lib/dnsRules';

const row = (match: string, server: string, note = '') => ({ match, server, note });

describe('isDnsName: the forms of the API', () => {
  it('takes geosite:, domain:, full: and a bare name', () => {
    for (const m of ['geosite:category-ru', 'domain:example.ru', 'full:www.example.ru', 'example.ru', 'localhost']) expect(isDnsName(m), m).toBe(true);
  });
  it('refuses keyword:, regexp:, ext:, geoip:, addresses, ports and empty tails', () => {
    for (const m of ['keyword:ads', 'regexp:.*', 'ext:my:ru', 'geoip:ru', '1.2.3.4', '10.0.0.0/8', '::1', 'port:80', 'domain:', 'geosite:', 'a b']) {
      expect(isDnsName(m), m).toBe(false);
    }
  });
});

describe('checkDnsDrafts', () => {
  it('a good row and a blank row are fine', () => {
    expect(checkDnsDrafts([row('geosite:category-ru example.ru', 'tcp://77.88.8.8'), row('', '')]).blocked).toBe(false);
  });
  it('marks a wrong server, by the parse the API uses', () => {
    const c = checkDnsDrafts([row('example.ru', 'dns.example'), row('example.ru', 'udp://1.1.1.1'), row('example.ru', 'https://dns.example/q?x=1')]);
    expect(c.rows.map((r) => r.badServer)).toEqual([true, true, true]);
    expect(c.blocked).toBe(true);
  });
  it('accepts the four kinds', () => {
    const servers = ['77.88.8.8', 'tcp://77.88.8.8:5353', 'tls://dns.example', 'https://dns.example/dns-query'];
    expect(checkDnsDrafts(servers.map((s) => row('example.ru', s))).blocked).toBe(false);
  });
  it('marks wrong names, and a half-filled row', () => {
    const c = checkDnsDrafts([row('keyword:ads example.ru', 'tcp://77.88.8.8'), row('example.ru', ''), row('', '1.1.1.1')]);
    expect(c.rows[0]!.badNames).toEqual(['keyword:ads']);
    expect(c.rows[1]!.incomplete).toBe(true);
    expect(c.rows[2]!.incomplete).toBe(true);
  });
  it('limits: 64 names in a row, 16 rows', () => {
    const names = Array.from({ length: 65 }, (_, i) => `a${i}.example`).join(' ');
    expect(checkDnsDrafts([row(names, '1.1.1.1')]).rows[0]!.tooManyNames).toBe(true);
    expect(checkDnsDrafts([row(names.split(' ').slice(0, 64).join(' '), '1.1.1.1')]).blocked).toBe(false);
    const many = Array.from({ length: 17 }, () => row('example.ru', '1.1.1.1'));
    expect(checkDnsDrafts(many).tooManyRules).toBe(true);
    expect(checkDnsDrafts(many.slice(0, 16)).blocked).toBe(false);
  });
});

describe('the request body', () => {
  it('names are split, the server trimmed, blank rows left out', () => {
    expect(dnsRulesOf([row('a.ru  b.ru, c.ru', ' tcp://77.88.8.8 ', ' про ru'), row('', '')])).toEqual([
      { match: ['a.ru', 'b.ru', 'c.ru'], server: 'tcp://77.88.8.8', note: 'про ru' },
    ]);
  });
  it('a stored rule goes to the row and back unchanged', () => {
    const rules = [{ match: ['geosite:category-ru', 'example.ru'], server: 'https://dns.example/dns-query', note: 'ru' }];
    expect(dnsRulesOf(dnsDrafts(rules))).toEqual(rules);
  });
});

describe('the refusal at its rows', () => {
  const res = (data: unknown) => ({ response: { status: 400, data } });
  it('names and servers go to their own lists', () => {
    const names = routingPresetRefusal(res({ error: 'ROUTING_PRESET_DNS_MATCH_INVALID', entries: ['keyword:x', 5] }));
    expect(names).toEqual({ code: 'ROUTING_PRESET_DNS_MATCH_INVALID', entries: ['keyword:x'] });
    expect(dnsRefusedOf(names)).toEqual({ names: ['keyword:x'], servers: [] });
    expect(dnsRefusedOf(routingPresetRefusal(res({ error: 'ROUTING_PRESET_DNS_SERVER_INVALID', entries: ['dns.example'] })))).toEqual({
      names: [],
      servers: ['dns.example'],
    });
  });
  it('another refusal marks nothing', () => {
    expect(dnsRefusedOf(null)).toBe(NO_DNS_REFUSED);
    expect(dnsRefusedOf({ code: 'NAME_TAKEN' })).toBe(NO_DNS_REFUSED);
  });
});
