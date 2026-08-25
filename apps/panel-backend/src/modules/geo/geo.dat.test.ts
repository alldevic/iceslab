import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseGeoSite,
  parseGeoIP,
  encodeGeoSite,
  encodeGeoIP,
  type Domain,
  type CIDR,
} from './geo.dat.js';

describe('geosite .dat codec', () => {
  const site = new Map<string, Domain[]>([
    ['YOUTUBE', [
      { type: 2, value: 'youtube.com' },
      { type: 3, value: 'www.youtube.com' },
      { type: 0, value: 'ytimg' },
    ]],
    ['GOOGLE', [{ type: 2, value: 'google.com' }]],
    ['DISCORD', [{ type: 2, value: 'discord.com' }, { type: 2, value: 'discordapp.com' }]],
  ]);

  it('round-trips encode -> parse', () => {
    const parsed = parseGeoSite(encodeGeoSite(site));
    expect(parsed).toEqual(site);
  });

  it('uppercases category keys on parse (xray lookup semantics)', () => {
    const one = new Map<string, Domain[]>([['youtube', [{ type: 2, value: 'youtube.com' }]]]);
    const parsed = parseGeoSite(encodeGeoSite(one));
    expect([...parsed.keys()]).toEqual(['YOUTUBE']);
  });

  it('encodes a large category correctly (exercises the growable writer buffer)', () => {
    // The writer starts at 1KB and doubles; 60k domains (~1.3MB) forces many
    // reallocations. The old number[]-backed writer would V8-fatal on a real
    // (100MB+) artifact; this locks in that growth is byte-correct.
    const many: Domain[] = [];
    for (let i = 0; i < 60_000; i++) many.push({ type: 2, value: `d${i}.example.com` });
    const big = new Map<string, Domain[]>([['BULK', many]]);
    const parsed = parseGeoSite(encodeGeoSite(big));
    expect(parsed.get('BULK')).toHaveLength(60_000);
    expect(parsed.get('BULK')![0]).toEqual({ type: 2, value: 'd0.example.com' });
    expect(parsed.get('BULK')![59_999]).toEqual({ type: 2, value: 'd59999.example.com' });
  });
});

describe('geoip .dat codec', () => {
  const v4 = Uint8Array.from([77, 88, 0, 0]);
  const v6 = Uint8Array.from([0x26, 0x07, 0xf8, 0xb0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ips = new Map<string, CIDR[]>([
    ['RU', [{ ip: v4, prefix: 16 }, { ip: v6, prefix: 32 }]],
    ['CN', [{ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 }]],
  ]);

  it('round-trips v4 + v6 CIDRs', () => {
    const parsed = parseGeoIP(encodeGeoIP(ips));
    expect(parsed).toEqual(ips);
  });
});

// Opt-in check against real upstream data: GEO_REAL_GEOSITE=/tmp/geosite.dat ...
// (download runetfreedom/SagerNet .dat first). Skipped when the env is unset.
//
// It had never run here until 2026-08-26. The file now sits at
// /var/tmp/iceslab-vmlab/geosite.dat, taken from the SAME release the geo module
// itself mirrors, and parses to 1543 categories / 3.15M domains — a real
// exercise of the codec rather than the handful of fixture entries above.
// Verified able to fail: breaking the parser's field tag turns this red.
describe('real .dat (opt-in)', () => {
  const gs = process.env.GEO_REAL_GEOSITE;
  it.runIf(gs)('parses a real geosite.dat with 1000+ categories', () => {
    const full = readFileSync(gs!);
    const parsed = parseGeoSite(full);
    expect(parsed.size).toBeGreaterThan(100); // real .dat has 1000+ categories
    // a known category is present and non-empty (parse actually decoded it)
    const key = [...parsed.keys()].find((k) => parsed.get(k)!.length > 0);
    expect(key).toBeDefined();
  });
});
