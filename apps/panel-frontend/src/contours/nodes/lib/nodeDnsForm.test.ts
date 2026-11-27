import { describe, expect, it } from 'vitest';
import type { DnsCfg } from '@iceslab/shared';
import {
  dnsBody,
  dnsDefaults,
  dnsHasAdvanced,
  dnsPatch,
  dnsProblems,
  carriedSummary,
  dnsSummary,
  emptyDnsServer,
  splitList,
  type DnsForm,
} from '@/contours/nodes/lib/nodeDnsForm';

const stored: DnsCfg = {
  servers: [
    { address: '77.88.8.8', domains: ['geosite:category-ru', 'full:a.test'], expectIps: ['geoip:ru'], skipFallback: true },
    { address: 'https://dns.google/dns-query', domains: [], expectIps: [], skipFallback: false },
  ],
  queryStrategy: 'UseIPv4',
  disableCache: true,
};

function form(p: Partial<DnsForm> = {}): DnsForm {
  return { servers: [], queryStrategy: '', disableCache: false, ...p };
}
const row = (p: Partial<ReturnType<typeof emptyDnsServer>> = {}) => ({ ...emptyDnsServer(), address: '1.1.1.1', ...p });

describe('dnsDefaults', () => {
  it('null, absent and an empty form are one state', () => {
    expect(dnsDefaults(null)).toEqual(form());
    expect(dnsDefaults(undefined)).toEqual(form());
  });

  it('a stored setting becomes rows of text, one entry per line', () => {
    const f = dnsDefaults(stored);
    expect(f.servers[0]).toEqual({
      address: '77.88.8.8',
      domains: 'geosite:category-ru\nfull:a.test',
      expectIps: 'geoip:ru',
      skipFallback: true,
    });
    expect(f.queryStrategy).toBe('UseIPv4');
    expect(f.disableCache).toBe(true);
  });
});

describe('splitList', () => {
  it('splits on lines and commas, trims, drops blanks', () => {
    expect(splitList(' a.test, b.test\n\n  c.test ,')).toEqual(['a.test', 'b.test', 'c.test']);
  });
});

describe('dnsProblems', () => {
  it('a valid form has none', () => {
    expect(dnsProblems(dnsDefaults(stored))).toEqual([]);
    expect(dnsProblems(form())).toEqual([]);
  });

  it('the 17th server is said on the list', () => {
    const f = form({ servers: Array.from({ length: 17 }, () => row()) });
    expect(dnsProblems(f)).toEqual([{ index: null, field: 'servers', code: 'tooMany', limit: 16 }]);
    expect(dnsProblems(form({ servers: Array.from({ length: 16 }, () => row()) }))).toEqual([]);
  });

  it('the 65th domain is said on that server, the 64th passes', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.test`).join('\n');
    expect(dnsProblems(form({ servers: [row({ domains: names(64) })] }))).toEqual([]);
    expect(dnsProblems(form({ servers: [row(), row({ domains: names(65) })] }))).toEqual([
      { index: 1, field: 'domains', code: 'tooMany', limit: 64 },
    ]);
  });

  it('an empty or blank address is required, an address over 253 is too long', () => {
    expect(dnsProblems(form({ servers: [row({ address: '   ' })] }))).toEqual([
      { index: 0, field: 'address', code: 'required' },
    ]);
    expect(dnsProblems(form({ servers: [row({ address: 'a'.repeat(254) })] }))).toEqual([
      { index: 0, field: 'address', code: 'tooLong', limit: 253 },
    ]);
    expect(dnsProblems(form({ servers: [row({ address: 'a'.repeat(253) })] }))).toEqual([]);
  });

  it('entry lengths: a domain over 253, an expectIps entry over 64, and 33 of them', () => {
    expect(dnsProblems(form({ servers: [row({ domains: 'a'.repeat(254) })] }))).toEqual([
      { index: 0, field: 'domains', code: 'tooLong', limit: 253 },
    ]);
    expect(dnsProblems(form({ servers: [row({ expectIps: 'a'.repeat(65) })] }))).toEqual([
      { index: 0, field: 'expectIps', code: 'tooLong', limit: 64 },
    ]);
    const ips = Array.from({ length: 33 }, (_, i) => `10.0.0.${i}`).join(',');
    expect(dnsProblems(form({ servers: [row({ expectIps: ips })] }))).toEqual([
      { index: 0, field: 'expectIps', code: 'tooMany', limit: 32 },
    ]);
  });
});

describe('dnsBody', () => {
  it('no servers is null: the reset', () => {
    expect(dnsBody(form())).toBeNull();
    // the switches say nothing without a server to apply to
    expect(dnsBody(form({ queryStrategy: 'UseIP', disableCache: true }))).toBeNull();
  });

  it('builds the server shape, trimmed, with lists split', () => {
    expect(
      dnsBody(form({ servers: [row({ address: ' 9.9.9.9 ', domains: 'a.test, b.test', skipFallback: true })] })),
    ).toEqual({
      servers: [{ address: '9.9.9.9', domains: ['a.test', 'b.test'], expectIps: [], skipFallback: true }],
    });
  });

  it('strategy and cache are present only when set', () => {
    const body = dnsBody(form({ servers: [row()], queryStrategy: 'UseIPv6', disableCache: true }));
    expect(body).toMatchObject({ queryStrategy: 'UseIPv6', disableCache: true });
    const plain = dnsBody(form({ servers: [row()] }));
    expect(plain).not.toHaveProperty('queryStrategy');
    expect(plain).not.toHaveProperty('disableCache');
  });

  it('a stored setting survives the round trip', () => {
    expect(dnsBody(dnsDefaults(stored))).toEqual(stored);
  });
});

describe('dnsPatch', () => {
  it('unchanged: nothing goes, so a save of the name does not re-push the node', () => {
    expect(dnsPatch(stored, dnsDefaults(stored))).toEqual({});
    expect(dnsPatch(null, form())).toEqual({});
    expect(dnsPatch(undefined, form())).toEqual({});
  });

  it('a server stored without the lists the server fills in is still unchanged', () => {
    const bare: DnsCfg = { servers: [{ address: '1.1.1.1' }] };
    expect(dnsPatch(bare, dnsDefaults(bare))).toEqual({});
  });

  it('set: the body goes under dns', () => {
    const f = form({ servers: [row({ domains: 'a.test' })] });
    expect(dnsPatch(null, f)).toEqual({
      dns: { servers: [{ address: '1.1.1.1', domains: ['a.test'], expectIps: [], skipFallback: false }] },
    });
  });

  it('edit: a changed domain goes', () => {
    const f = dnsDefaults(stored);
    f.servers[0].domains = 'full:other.test';
    expect(dnsPatch(stored, f).dns?.servers[0].domains).toEqual(['full:other.test']);
  });

  it('reset: an emptied form over a stored setting sends dns: null', () => {
    expect(dnsPatch(stored, form())).toEqual({ dns: null });
  });
});

describe('dnsHasAdvanced', () => {
  it('true for strategy, cache or expectIps; false otherwise', () => {
    expect(dnsHasAdvanced(form({ servers: [row()] }))).toBe(false);
    expect(dnsHasAdvanced(form({ servers: [row()], queryStrategy: 'UseIP' }))).toBe(true);
    expect(dnsHasAdvanced(form({ servers: [row()], disableCache: true }))).toBe(true);
    expect(dnsHasAdvanced(form({ servers: [row({ expectIps: 'geoip:ru' })] }))).toBe(true);
  });
});

describe('dnsSummary', () => {
  it('counts servers and domain entries; no dns is zero of each', () => {
    expect(dnsSummary({ dns: stored })).toEqual({ servers: 2, domains: 2 });
    expect(dnsSummary({ dns: null })).toEqual({ servers: 0, domains: 0 });
    expect(dnsSummary({})).toEqual({ servers: 0, domains: 0 });
  });
});

describe('carriedSummary (19.12)', () => {
  it('counts the rules carried from presets and the panel, apart from the manual dns', () => {
    const rule = { match: ['a.test'], server: '10.0.0.1', overridden: [] };
    expect(carriedSummary({ carriedDns: [{ presetId: 'p', rules: [rule, rule] }, { presetId: null, rules: [rule] }, { presetId: 'q', rules: [] }] })).toEqual({ rules: 3, sources: 2 });
  });

  it('is zero for a node that carries none and for a server older than the field', () => {
    expect(carriedSummary({ carriedDns: [] })).toEqual({ rules: 0, sources: 0 });
    expect(carriedSummary({})).toEqual({ rules: 0, sources: 0 });
  });
});
