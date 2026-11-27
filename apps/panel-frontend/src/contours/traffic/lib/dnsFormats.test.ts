import { describe, expect, it } from 'vitest';
import { DNS_FORMATS } from '@/contours/traffic/lib/dnsFormats';

const row = (id: string) => DNS_FORMATS.find((r) => r.id === id)!;

describe('the table of formats that run a DNS rule (stage 19)', () => {
  it('stash, old clash, wireguard, amneziawg and the link formats do not run it', () => {
    for (const id of ['stash', 'clash', 'wireguard', 'amneziawg', 'links', 'surge', 'loon', 'quantumultx', 'outline']) {
      expect(row(id).runs, id).toBe(false);
      expect(row(id).kinds, id).toBeNull();
    }
  });

  it('the formats that run it are the five of the plan', () => {
    expect(DNS_FORMATS.filter((r) => r.runs).map((r) => r.id)).toEqual(['xray-json', 'xray-array', 'xkeen', 'mihomo', 'sing-box']);
  });

  it('kinds follow the measurements of m19-01: xray has no DoT, sing-box has all, the rest was not run', () => {
    expect(row('xray-json').kinds).toEqual(['udp', 'tcp', 'https']);
    expect(row('sing-box').kinds).toEqual(['udp', 'tcp', 'tls', 'https']);
    for (const id of ['xkeen', 'mihomo']) expect(row(id).kinds, id).toBe('unverified');
  });

  it('a format that does not run the rule is never marked as coming', () => {
    expect(DNS_FORMATS.filter((r) => !r.runs && r.soon)).toEqual([]);
  });

  it('every row has a unique id', () => {
    expect(new Set(DNS_FORMATS.map((r) => r.id)).size).toBe(DNS_FORMATS.length);
  });
});
