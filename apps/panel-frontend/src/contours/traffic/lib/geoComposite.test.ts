import { describe, expect, it } from 'vitest';
import type { GeoSet } from '@/lib/domain/geoSets';
import {
  buildDefinition,
  checkDrafts,
  compositeStats,
  definitionReady,
  draftFromCategory,
  locateRefusal,
  newDraft,
  parseEntries,
  sourceChoices,
  type CategoryDraft,
} from './geoComposite';

const draft = (over: Partial<CategoryDraft>): CategoryDraft => ({ ...newDraft('video'), ...over });
const set = (name: string, kind: 'geosite' | 'geoip', type: 'builtin' | 'upload' | 'composite'): GeoSet =>
  ({
    name,
    kind,
    source:
      type === 'builtin' ? { type, tag: 't' } : type === 'upload' ? { type, filename: 'f.dat' } : { type, categories: [] },
  }) as unknown as GeoSet;

describe('parseEntries', () => {
  it('по строке на запись, края и пустые строки долой, CRLF тоже', () => {
    expect(parseEntries('  full:example.org \r\n\n myhost.example\n   \n')).toEqual(['full:example.org', 'myhost.example']);
    expect(parseEntries('')).toEqual([]);
  });
});

describe('buildDefinition', () => {
  it('собирает определение из введённого текста, порядок сохраняется', () => {
    const d = draft({
      name: ' video ',
      refs: [
        { set: 'geosite', tag: 'youtube' },
        { set: 'geosite', tag: 'netflix' },
      ],
      manualText: 'full:example.org\nmyhost.example\n',
      excludeText: 'ytimg.com',
      enabled: false,
    });
    expect(buildDefinition([d, draft({ name: 'empty' })])).toEqual([
      {
        name: 'video',
        refs: [
          { set: 'geosite', tag: 'youtube' },
          { set: 'geosite', tag: 'netflix' },
        ],
        manual: ['full:example.org', 'myhost.example'],
        exclude: ['ytimg.com'],
        enabled: false,
      },
      { name: 'empty', refs: [], manual: [], exclude: [], enabled: true },
    ]);
  });

  it('определение набора -> черновик -> то же определение', () => {
    const def = [{ name: 'a', refs: [{ set: 's', tag: 't' }], manual: ['1.2.3.0/24'], exclude: ['1.2.3.4'], enabled: true }];
    expect(buildDefinition(def.map(draftFromCategory))).toEqual(def);
  });
});

describe('checkDrafts', () => {
  it('пустое имя, форма имени, повтор имени', () => {
    const a = draft({ name: '' });
    const b = draft({ name: 'Bad Name' });
    const c = draft({ name: 'same' });
    const d = draft({ name: 'same ' });
    const ok = draft({ name: 'fine' });
    const r = checkDrafts('mine', [a, b, c, d, ok]);
    expect(r.get(a.key)).toEqual(['name-empty']);
    expect(r.get(b.key)).toEqual(['name-shape']);
    expect(r.get(c.key)).toEqual(['name-twice']);
    expect(r.get(d.key)).toEqual(['name-twice']);
    expect(r.has(ok.key)).toBe(false);
  });

  it('ссылка на сам набор, недописанная ссылка, одна и та же ссылка дважды', () => {
    const own = draft({ refs: [{ set: 'mine', tag: 'x' }] });
    expect(checkDrafts('mine', [own]).get(own.key)).toEqual(['ref-self']);
    expect(checkDrafts('', [own]).size).toBe(0); // имя нового набора ещё не введено
    const half = draft({ refs: [{ set: 'geosite', tag: '' }] });
    expect(checkDrafts('mine', [half]).get(half.key)).toEqual(['ref-incomplete']);
    const twice = draft({
      refs: [
        { set: 'geosite', tag: 'google' },
        { set: 'geosite', tag: 'GOOGLE' },
      ],
    });
    expect(checkDrafts('mine', [twice]).get(twice.key)).toEqual(['ref-twice']);
  });

  it('definitionReady: нужна хотя бы одна категория и ни одной ошибки', () => {
    expect(definitionReady('mine', [])).toBe(false);
    expect(definitionReady('mine', [draft({})])).toBe(true);
    expect(definitionReady('mine', [draft({ name: '' })])).toBe(false);
  });
});

describe('sourceChoices', () => {
  const sets = [
    set('geosite', 'geosite', 'builtin'),
    set('geoip', 'geoip', 'builtin'),
    set('my-up', 'geosite', 'upload'),
    set('mine', 'geosite', 'composite'),
    set('other-comp', 'geoip', 'composite'),
    set('ip-up', 'geoip', 'upload'),
  ];
  it('только набор того же вида и не составной', () => {
    expect(sourceChoices(sets, 'geosite').map((s) => s.name)).toEqual(['geosite', 'my-up']);
    expect(sourceChoices(sets, 'geoip').map((s) => s.name)).toEqual(['geoip', 'ip-up']);
  });
  it('сам набор не предлагается', () => {
    expect(sourceChoices(sets, 'geosite', 'my-up').map((s) => s.name)).toEqual(['geosite']);
  });
});

describe('locateRefusal: отказ сервера -> категория и запись', () => {
  const v = draft({
    name: 'video',
    refs: [{ set: 'geosite', tag: 'nope' }],
    manualText: 'full:ok.org\nbad entry',
    excludeText: 'x y',
  });
  const w = draft({ name: 'other' });
  it('неверная ручная запись, исключение и отсутствующая категория источника', () => {
    expect(locateRefusal([w, v], { category: 'video', entry: 'bad entry' })).toEqual({ key: v.key, field: 'manual', entry: 'bad entry' });
    expect(locateRefusal([w, v], { category: 'video', entry: 'x y' })).toEqual({ key: v.key, field: 'exclude', entry: 'x y' });
    expect(locateRefusal([w, v], { category: 'video', entry: 'geosite:nope' })).toEqual({ key: v.key, field: 'ref', entry: 'geosite:nope' });
  });
  it('только категория (имя, повтор, пределы): поле не названо', () => {
    expect(locateRefusal([v], { category: 'video', entry: null })).toEqual({ key: v.key, field: 'name', entry: null });
  });
  it('запись, которую сервер обрезал до 40 знаков', () => {
    const long = draft({ name: 'l', manualText: `${'a'.repeat(600)}.org` });
    expect(locateRefusal([long], { category: 'l', entry: `${'a'.repeat(40)}...` })).toMatchObject({ field: 'manual' });
  });
  it('нет категории с таким именем или нет `at`: null, текст остаётся общим', () => {
    expect(locateRefusal([v], { category: 'gone', entry: 'x' })).toBeNull();
    expect(locateRefusal([v], null)).toBeNull();
    expect(locateRefusal([v], { category: null, entry: 'x' })).toBeNull();
  });
});

describe('compositeStats', () => {
  it('число категорий и число разных наборов-источников', () => {
    expect(compositeStats([])).toEqual({ categories: 0, sets: 0 });
    expect(
      compositeStats([
        { name: 'a', refs: [{ set: 'geosite', tag: 'x' }, { set: 'geosite', tag: 'y' }, { set: 'up', tag: 'z' }], manual: [], exclude: [], enabled: true },
        { name: 'b', refs: [], manual: ['m'], exclude: [], enabled: false },
      ]),
    ).toEqual({ categories: 2, sets: 2 });
  });
});
