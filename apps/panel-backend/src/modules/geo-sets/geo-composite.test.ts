import { describe, expect, it } from 'vitest';
import type { GeoCompositeCategory, GeoSetKind } from '@iceslab/shared';
import { ROOT, cidr, datFile, domain, geoip, site } from '../../../tests/helpers/geo-dat.js';
import { geoipEntries, geositeEntries, parseGeoDat } from './geo-dat.js';
import { parseCidr } from './geo-formats.js';
import {
  GeoCompositeError,
  buildCompositeDat,
  checkCompositeShape,
  composeCategory,
  parseManualDomain,
  type CompositeSource,
} from './geo-composite.js';

/**
 * Milestone 10.2: the file of a composite set. The cases are those of the
 * fork's geo.compose.test.ts and geo.categories.test.ts, on this base's codec.
 */
const src = (bytes: Uint8Array, kind: GeoSetKind): CompositeSource => ({ buf: bytes, index: parseGeoDat(bytes, kind) });

const a = src(datFile(site('YOUTUBE', domain(ROOT, 'youtube.com'), domain(ROOT, 'ytimg.com'))), 'geosite');
const b = src(datFile(site('MYLIST', domain(ROOT, 'youtube.com'), domain(ROOT, 'googlevideo.com'))), 'geosite');
const sources = new Map([
  ['a', a],
  ['b', b],
]);
const cat = (name: string, p: Partial<GeoCompositeCategory> = {}): GeoCompositeCategory => ({
  name,
  refs: [],
  manual: [],
  exclude: [],
  enabled: true,
  ...p,
});

describe('parseManualDomain', () => {
  it('maps the prefixes to the .dat types, a bare name is a domain', () => {
    expect(parseManualDomain('example.com')).toEqual({ type: 'domain', value: 'example.com' });
    expect(parseManualDomain('full:X.com')).toEqual({ type: 'full', value: 'x.com' });
    expect(parseManualDomain('domain:y.com')).toEqual({ type: 'domain', value: 'y.com' });
    expect(parseManualDomain('keyword:ads')).toEqual({ type: 'plain', value: 'ads' });
    expect(parseManualDomain('regexp:.*\\.ru$')).toEqual({ type: 'regex', value: '.*\\.ru$' });
  });
  it('refuses what is not a name', () => {
    for (const bad of ['', '  ', 'full:', 'http://x.com', 'a b.com', 'x.com:8080', 'a@b']) expect(parseManualDomain(bad), bad).toBeNull();
  });
});

describe('parseCidr, as the manual entries need it', () => {
  it('refuses a trailing slash and other prefix leniency (it would read as /0)', () => {
    expect(parseCidr('1.2.3.0/24')).toEqual({ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 });
    expect(parseCidr('8.8.8.8')!.prefix).toBe(32);
    for (const bad of ['1.2.3.4/', '1.2.3.0/1e1', '2001:db8::/', '1.2.3.0/33', '1.2.3', '1.2.3.0/24/5', '']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe('composeCategory', () => {
  it('merges categories of several sets and manual entries, repeats once', () => {
    const c = composeCategory(
      'geosite',
      cat('video', {
        refs: [
          { set: 'a', tag: 'youtube' },
          { set: 'b', tag: 'mylist' },
        ],
        manual: ['full:vimeo.com', 'youtube.com'],
      }),
      sources,
    );
    expect(c.domains).toEqual([
      { type: 'domain', value: 'youtube.com' },
      { type: 'domain', value: 'ytimg.com' },
      { type: 'domain', value: 'googlevideo.com' },
      { type: 'full', value: 'vimeo.com' },
    ]);
  });

  it('applies exclusions, by value, any case', () => {
    const c = composeCategory('geosite', cat('x', { refs: [{ set: 'a', tag: 'youtube' }], exclude: ['YTIMG.COM'] }), sources);
    expect(c.domains.map((d) => d.value)).toEqual(['youtube.com']);
  });

  it('a set or a category that is not there is an error naming it, not a smaller list', () => {
    expect(() => composeCategory('geosite', cat('x', { refs: [{ set: 'a', tag: 'nope' }] }), sources)).toThrowError(
      /category "x": set "a" has no category "nope"/,
    );
    expect(() => composeCategory('geosite', cat('x', { refs: [{ set: 'zz', tag: 'y' }] }), sources)).toThrowError(/set "zz"/);
  });

  it('a bad manual entry is refused with the entry', () => {
    try {
      composeCategory('geosite', cat('x', { manual: ['ok.com', 'a b'] }), sources);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GeoCompositeError);
      expect((err as GeoCompositeError).at).toEqual({ category: 'x', entry: 'a b' });
    }
  });

  it('geoip: merges, repeats once, excludes a CIDR', () => {
    const ipA = src(datFile(geoip('RU', cidr([77, 88, 0, 0], 16), cidr([10, 0, 0, 0], 8))), 'geoip');
    const c = composeCategory(
      'geoip',
      cat('ru-plus', { refs: [{ set: 'ips', tag: 'ru' }], manual: ['77.88.0.0/16', '192.168.1.1', '2001:db8::/32'], exclude: ['10.0.0.0/8'] }),
      new Map([['ips', ipA]]),
    );
    expect(c.cidrs.map((x) => `${Array.from(x.ip).length}/${x.prefix}`)).toEqual(['4/16', '4/32', '16/32']);
  });
});

describe('buildCompositeDat', () => {
  it('writes the categories as upper-case codes, in the order of the definition', () => {
    const dat = buildCompositeDat(
      'geosite',
      [cat('beta', { manual: ['b.com'] }), cat('alpha', { refs: [{ set: 'a', tag: 'youtube' }] })],
      sources,
    )!;
    const idx = parseGeoDat(dat, 'geosite');
    expect(idx.tags.map((t) => t.name)).toEqual(['beta', 'alpha']);
    expect(idx.unreachable).toEqual([]);
    expect(geositeEntries(dat, idx, 'alpha')).toEqual([
      { type: 'domain', value: 'youtube.com' },
      { type: 'domain', value: 'ytimg.com' },
    ]);
  });

  it('is the same bytes for the same definition', () => {
    const def = [cat('x', { refs: [{ set: 'a', tag: 'youtube' }], manual: ['full:z.com'] })];
    expect(Buffer.from(buildCompositeDat('geosite', def, sources)!).equals(Buffer.from(buildCompositeDat('geosite', def, sources)!))).toBe(true);
  });

  it('leaves out a disabled category and one that comes out empty; null when nothing is left', () => {
    const dat = buildCompositeDat(
      'geosite',
      [cat('off', { manual: ['a.com'], enabled: false }), cat('empty', { refs: [{ set: 'a', tag: 'youtube' }], exclude: ['youtube.com', 'ytimg.com'] }), cat('on', { manual: ['c.com'] })],
      sources,
    )!;
    expect(parseGeoDat(dat, 'geosite').tags.map((t) => t.name)).toEqual(['on']);
    expect(buildCompositeDat('geosite', [cat('off', { manual: ['a.com'], enabled: false })], sources)).toBeNull();
    expect(buildCompositeDat('geosite', [], sources)).toBeNull();
  });

  it('geoip file reads back', () => {
    const dat = buildCompositeDat('geoip', [cat('mine', { manual: ['1.2.3.0/24'] })], new Map())!;
    const idx = parseGeoDat(dat, 'geoip');
    expect(geoipEntries(dat, idx, 'mine').map((c) => [Array.from(c.ip), c.prefix])).toEqual([[[1, 2, 3, 0], 24]]);
  });
});

describe('checkCompositeShape', () => {
  it('names, repeats, limits and entries', () => {
    expect(() => checkCompositeShape('geosite', [cat('Bad Name')])).toThrowError(/category name "Bad Name"/);
    expect(() => checkCompositeShape('geosite', [cat('x'), cat('x')])).toThrowError(/named twice/);
    expect(() => checkCompositeShape('geosite', [cat('x', { manual: ['ok.com', 'a b'] })])).toThrowError(/"a b" is not a domain entry/);
    expect(() => checkCompositeShape('geoip', [cat('x', { manual: ['1.2.3.4/'] })])).toThrowError(/"1.2.3.4\/" is not an address/);
    expect(() => checkCompositeShape('geoip', [cat('x', { exclude: ['nope'] })])).toThrowError(/is not an address/);
    expect(() => checkCompositeShape('geosite', [cat('ok', { manual: ['example.com'], exclude: ['x.com'] })])).not.toThrow();
  });
});

