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

/**
 * Two categories: GOOD, and POISON whose single domain has a field with wire
 * type 3 — a type this codec does not support and throws on. Hand-built because
 * the encoder cannot produce it, which is the point: it is unreachable unless
 * the domains are decoded.
 */
function poisonedSecondCategory(): Uint8Array {
  const bytes: number[] = [];
  const varint = (n: number): void => {
    while (n > 127) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  };
  const lenDelim = (field: number, payload: number[]): void => {
    varint(field * 8 + 2);
    varint(payload.length);
    bytes.push(...payload);
  };
  const str = (s: string): number[] => [...new TextEncoder().encode(s)];
  const sub = (build: (out: number[]) => void): number[] => {
    const out: number[] = [];
    build(out);
    return out;
  };
  const strField = (out: number[], field: number, value: string): void => {
    out.push(field * 8 + 2, value.length, ...str(value));
  };

  // GOOD { country_code: "GOOD", domain: { type: 2, value: "kept.example" } }
  lenDelim(
    1,
    sub((out) => {
      strField(out, 1, 'GOOD');
      const dom = sub((d) => {
        d.push(1 * 8 + 0, 2); // type = 2 (suffix)
        strField(d, 2, 'kept.example');
      });
      out.push(2 * 8 + 2, dom.length, ...dom);
    }),
  );
  // POISON { country_code: "POISON", domain: { <field 1, wire 3> } }
  lenDelim(
    1,
    sub((out) => {
      strField(out, 1, 'POISON');
      const dom = [1 * 8 + 3]; // wire type 3: parseGeoSite's Reader.skip throws
      out.push(2 * 8 + 2, dom.length, ...dom);
    }),
  );
  return Uint8Array.from(bytes);
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

  it('does not decode the categories it was not asked for', () => {
    // The claim is about work not done, so it is proved by work that would fail
    // if it were done: an entry whose DOMAIN carries an unsupported wire type.
    // The country-code pass steps over a domain submessage without descending
    // into it, so this only throws if something actually decodes the domains.
    //
    // Deterministic on purpose. The size of the saving was measured on the real
    // sources (590 MB of heap, 762 MB RSS, on a build with no categories at
    // all); a heap-delta assertion inside a suite that is also allocating tells
    // you about the suite, not about the parser.
    const bytes = poisonedSecondCategory();
    expect(() => parseGeoSite(bytes), 'the poison is inert, so this proves nothing').toThrow();
    const good = parseGeoSite(bytes, ['GOOD']);
    expect([...good.keys()]).toEqual(['GOOD']);
    expect(good.get('GOOD')).toEqual([{ type: 2, value: 'kept.example' }]);
  });
});
