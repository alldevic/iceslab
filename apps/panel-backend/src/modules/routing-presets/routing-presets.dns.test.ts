import { describe, it, expect } from 'vitest';
import { parseDnsServer } from '@iceslab/shared';
import { DnsRulesSchema, dnsRuleProblem, isDnsMatchName } from './routing-presets.dns.js';

/**
 * Stage 19.2: the parse of a DNS rule's `server` (it lives in
 * packages/shared, which has no tests of its own) and the checks on a rule.
 */
describe('parseDnsServer', () => {
  it('a bare IP is UDP/53, v4 or v6', () => {
    expect(parseDnsServer('77.88.8.8')).toEqual({ kind: 'udp', host: '77.88.8.8', port: 53, path: '' });
    expect(parseDnsServer('2a02:6b8::feed:0ff')).toMatchObject({ kind: 'udp', host: '2a02:6b8::feed:0ff', port: 53 });
  });

  it('tcp:// takes an IP, the port is 53 unless given, a v6 literal is bracketed', () => {
    expect(parseDnsServer('tcp://10.0.0.1')).toEqual({ kind: 'tcp', host: '10.0.0.1', port: 53, path: '' });
    expect(parseDnsServer('tcp://10.0.0.1:5353')).toMatchObject({ kind: 'tcp', port: 5353 });
    expect(parseDnsServer('tcp://[2001:db8::1]')).toMatchObject({ kind: 'tcp', host: '2001:db8::1', port: 53 });
    expect(parseDnsServer('tcp://[2001:db8::1]:5353')).toMatchObject({ host: '2001:db8::1', port: 5353 });
  });

  it('tls:// takes a host name or an IP, the port is 853 unless given', () => {
    expect(parseDnsServer('tls://dns.example.com')).toEqual({ kind: 'tls', host: 'dns.example.com', port: 853, path: '' });
    expect(parseDnsServer('tls://dns.example.com:8853')).toMatchObject({ port: 8853 });
    expect(parseDnsServer('tls://9.9.9.9')).toMatchObject({ kind: 'tls', host: '9.9.9.9' });
  });

  it('https:// takes a host name or an IP and a path, the port is 443 unless given', () => {
    expect(parseDnsServer('https://dns.example.com/dns-query')).toEqual({ kind: 'https', host: 'dns.example.com', port: 443, path: '/dns-query' });
    expect(parseDnsServer('https://1.1.1.1:8443/x/y')).toMatchObject({ host: '1.1.1.1', port: 8443, path: '/x/y' });
    expect(parseDnsServer('https://dns.example.com')).toMatchObject({ path: '/dns-query' });
  });

  it.each([
    ['udp://1.1.1.1', 'the udp:// scheme'],
    ['1.1.1.1:53', 'an IP with a port and no scheme'],
    ['https://', 'https with no host'],
    ['https:///dns-query', 'https with no host, a path'],
    ['dns.example.com', 'a name for UDP'],
    ['tcp://dns.example.com', 'a name for TCP'],
    ['tcp://2001:db8::1:53', 'an unbracketed v6 with a scheme'],
    ['tls://', 'tls with no host'],
    ['tls://dns.example.com:0', 'port 0'],
    ['tls://dns.example.com:70000', 'port out of range'],
    ['https://dns.example.com/q?x=1', 'a query'],
    ['http://dns.example.com/dns-query', 'plain http'],
    ['quic://dns.example.com', 'an unknown scheme'],
    ['999.1.1.1', 'a bad IPv4'],
    [' 1.1.1.1', 'padding'],
    ['1.1.1.1\nx', 'a line break'],
    ['', 'empty'],
    ['tls://bad_host.example', 'an underscore in a host'],
  ])('refuses %j (%s)', (s) => {
    expect(parseDnsServer(s)).toBeNull();
  });
});

describe('dns rule names', () => {
  it('geosite:, domain:, full: and a bare name are names; the rest is not', () => {
    for (const ok of ['geosite:google', 'domain:corp.example', 'full:a.corp.example', 'corp.example']) expect(isDnsMatchName(ok), ok).toBe(true);
    for (const bad of ['keyword:corp', 'regexp:^a', 'geoip:ru', '10.0.0.0/8', '1.1.1.1', 'port:53', 'ext:corp:office', 'not a name']) {
      expect(isDnsMatchName(bad), bad).toBe(false);
    }
  });
});

describe('dnsRuleProblem and the schema', () => {
  const rule = (over: Record<string, unknown> = {}) => ({ match: ['domain:corp.example'], server: 'tcp://10.0.0.1', note: '', ...over });

  it('a good rule has no problem; the note defaults to empty', () => {
    expect(dnsRuleProblem([rule()])).toBeNull();
    expect(DnsRulesSchema.parse([{ match: ['corp.example'], server: '10.0.0.1' }])[0]!.note).toBe('');
  });

  it('names and servers are refused with their own code and the entries', () => {
    expect(dnsRuleProblem([rule({ match: ['domain:a.example', 'keyword:x'] })])).toMatchObject({
      code: 'ROUTING_PRESET_DNS_MATCH_INVALID',
      entries: ['keyword:x'],
    });
    expect(dnsRuleProblem([rule({ server: 'udp://1.1.1.1' })])).toMatchObject({
      code: 'ROUTING_PRESET_DNS_SERVER_INVALID',
      entries: ['udp://1.1.1.1'],
    });
  });

  it('16 rules and 64 names pass, 17 and 65 do not', () => {
    expect(DnsRulesSchema.safeParse(Array.from({ length: 16 }, () => rule())).success).toBe(true);
    expect(DnsRulesSchema.safeParse(Array.from({ length: 17 }, () => rule())).success).toBe(false);
    const names = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.example`);
    expect(DnsRulesSchema.safeParse([rule({ match: names(64) })]).success).toBe(true);
    expect(DnsRulesSchema.safeParse([rule({ match: names(65) })]).success).toBe(false);
    expect(DnsRulesSchema.safeParse([rule({ match: [] })]).success).toBe(false);
  });
});
