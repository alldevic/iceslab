import { describe, expect, it } from 'vitest';
import {
  parseGeoSite,
  parseGeoIP,
  encodeGeoSite,
  encodeGeoIP,
  type Domain,
  type CIDR,
} from './geo.dat.js';

/**
 * Parsing is how categories are enumerated, so it used to be done in full every
 * time a build ran at all — including a build with no custom categories, whose
 * whole output is a copy of bytes already in hand. On the runetfreedom sources
 * that is 3.15M domains and 1.23M networks: measured 590 MB of heap and 762 MB
 * RSS, above the image's own `--max-old-space-size=512`, and with GEO_SELF_HOST
 * on it turned the start-up warm-up into a crash loop.
 *
 * Every caller knows which categories it wants. What is asserted here is that
 * asking for some means building only those, and that asking for none still
 * means everything — the callers that enumerate depend on it.
 */

function bigSite(categories: number, perCategory: number): Map<string, Domain[]> {
  const m = new Map<string, Domain[]>();
  for (let c = 0; c < categories; c++) {
    const doms: Domain[] = [];
    for (let i = 0; i < perCategory; i++) doms.push({ type: 2, value: `d${i}.cat${c}.example` });
    m.set(`CAT${c}`, doms);
  }
  return m;
}

describe('a parse builds only what was asked for', () => {
  it('returns just the named categories', () => {
    const bytes = encodeGeoSite(bigSite(5, 10));
    const some = parseGeoSite(bytes, ['CAT1', 'CAT3']);
    expect([...some.keys()].sort()).toEqual(['CAT1', 'CAT3']);
    expect(some.get('CAT1')).toHaveLength(10);
  });

  it('matches the name case-insensitively, like every other geo lookup here', () => {
    const bytes = encodeGeoSite(bigSite(2, 1));
    expect([...parseGeoSite(bytes, ['cat0']).keys()]).toEqual(['CAT0']);
  });

  it('is byte-for-byte the same answer as the unfiltered parse, for what it returns', () => {
    // The filter must narrow, not alter. A filtered parse that decoded
    // differently would put a different rule on a node than the preview showed.
    const bytes = encodeGeoSite(bigSite(4, 25));
    expect(parseGeoSite(bytes, ['CAT2']).get('CAT2')).toEqual(parseGeoSite(bytes).get('CAT2'));
  });

  it('still returns everything when nothing is named', () => {
    // The enumerating callers (the category editor's source listing) depend on
    // this, and it is what every existing caller did.
    const bytes = encodeGeoSite(bigSite(3, 2));
    expect([...parseGeoSite(bytes).keys()].sort()).toEqual(['CAT0', 'CAT1', 'CAT2']);
  });

  it('answers empty for a name the file does not have, rather than everything', () => {
    const bytes = encodeGeoSite(bigSite(3, 2));
    expect(parseGeoSite(bytes, ['ABSENT']).size).toBe(0);
  });

  it('narrows geoip the same way', () => {
    const ips = new Map<string, CIDR[]>([
      ['RU', [{ ip: Uint8Array.from([77, 88, 0, 0]), prefix: 16 }]],
      ['CN', [{ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 }]],
      ['US', [{ ip: Uint8Array.from([8, 8, 8, 0]), prefix: 24 }]],
    ]);
    const bytes = encodeGeoIP(ips);
    const some = parseGeoIP(bytes, ['ru', 'us']);
    expect([...some.keys()].sort()).toEqual(['RU', 'US']);
    expect(some.get('RU')).toEqual(ips.get('RU'));
  });

  it('does not build the objects it was not asked for', () => {
    // The claim is about memory, so measure memory rather than trust the shape
    // of the code. 400k domains across 20 categories is ~10MB of wire and, fully
    // parsed, tens of MB of JS objects; one category out of twenty must cost a
    // small fraction of that. A range rather than a number: GC timing is not
    // deterministic, and the point is the order of magnitude.
    const bytes = encodeGeoSite(bigSite(20, 20_000));
    const measure = (run: () => unknown): number => {
      global.gc?.();
      const before = process.memoryUsage().heapUsed;
      const kept = run();
      const after = process.memoryUsage().heapUsed;
      expect(kept).toBeTruthy();
      return after - before;
    };
    const all = measure(() => parseGeoSite(bytes));
    const one = measure(() => parseGeoSite(bytes, ['CAT7']));
    expect(one).toBeLessThan(all / 4);
  });
});
