import { describe, expect, it } from 'vitest';
import {
  domainsToSingboxRule,
  cidrToString,
  cidrsToSingboxRule,
  compileSrs,
} from './geo.srs.js';
import type { Domain, CIDR } from './geo.dat.js';

describe('sing-box source mapping', () => {
  it('maps Domain.type to the right sing-box fields', () => {
    const rule = domainsToSingboxRule([
      { type: 2, value: 'youtube.com' },
      { type: 3, value: 'www.x.com' },
      { type: 0, value: 'ads' },
      { type: 1, value: '.*\\.ru' },
    ]);
    expect(rule).toEqual({
      domain_suffix: ['youtube.com'],
      domain: ['www.x.com'],
      domain_keyword: ['ads'],
      domain_regex: ['.*\\.ru'],
    });
  });

  it('formats v4 + v6 CIDRs', () => {
    expect(cidrToString({ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 })).toBe('1.2.3.0/24');
    expect(
      cidrToString({
        ip: Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        prefix: 32,
      }),
    ).toBe('2001:db8:0:0:0:0:0:0/32');
    expect(cidrsToSingboxRule([{ ip: Uint8Array.from([8, 8, 8, 8]), prefix: 32 }])).toEqual({
      ip_cidr: ['8.8.8.8/32'],
    });
  });
});

// Opt-in: SINGBOX_BIN=/path/to/sing-box compiles a real .srs. Skipped when unset.
describe('compileSrs (opt-in on SINGBOX_BIN)', () => {
  const bin = process.env.SINGBOX_BIN;
  it.runIf(bin)('compiles a category to non-empty .srs bytes', async () => {
    const domains: Domain[] = [
      { type: 2, value: 'youtube.com' },
      { type: 3, value: 'www.youtube.com' },
    ];
    const cidrs: CIDR[] = [{ ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 }];
    const srs = await compileSrs(bin!, domains, cidrs);
    expect(srs.length).toBeGreaterThan(0);
  });
});
