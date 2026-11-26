import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import ru from '@/i18n/locales/ru';

/**
 * Ratchets on the translations. i18next prints the key itself when a string is
 * missing, so a locale that drifts shows `profiles.form.cfg.pqNeedsSeed` in the
 * UI and nothing fails. `keysPresent.test.ts` checks that every literal key the
 * code asks for exists; this file checks the locales against each other and the
 * source against prose that never became a key.
 */
const FILES = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function flatten(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

function nonStrings(o: unknown, prefix = ''): string[] {
  if (o !== null && typeof o === 'object') {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => nonStrings(v, prefix ? `${prefix}.${k}` : k));
  }
  return typeof o === 'string' ? [] : [prefix];
}

/**
 * i18next spells plurals as sibling keys: `nodes_one`, `nodes_other`, and in
 * Russian also `_few` / `_many`. The locales are not meant to hold the same raw
 * keys, so what has to match is the FAMILY - the name the code asks for.
 */
const PLURAL = /_(zero|one|two|few|many|other)$/;
const family = (k: string): string => k.replace(PLURAL, '');

const enKeys = new Set(flatten(en));
const ruKeys = new Set(flatten(ru));
const enFamilies = new Set([...enKeys].map(family));
const ruFamilies = new Set([...ruKeys].map(family));

describe('locale parity', () => {
  it('ru covers every key family en has', () => {
    expect([...enFamilies].filter((k) => !ruFamilies.has(k)).sort()).toEqual([]);
  });

  it('en covers every key family ru has', () => {
    expect([...ruFamilies].filter((k) => !enFamilies.has(k)).sort()).toEqual([]);
  });

  it('a plural family never comes without `_other`, the fallback every language needs', () => {
    const lonely = (keys: Set<string>) =>
      [...new Set([...keys].filter((k) => PLURAL.test(k)).map(family))].filter((f) => !keys.has(`${f}_other`)).sort();
    expect(lonely(enKeys)).toEqual([]);
    expect(lonely(ruKeys)).toEqual([]);
  });

  it('no key holds a non-string', () => {
    // An object under a leaf renders as [object Object]; a number or null is a typo.
    expect(nonStrings(en)).toEqual([]);
    expect(nonStrings(ru)).toEqual([]);
  });
});

const sources = Object.entries(FILES).filter(([path]) => !path.includes('/i18n/') && !/\.test\.tsx?$/.test(path));

describe('keys built at run time', () => {
  // keysPresent.test.ts can only read literal keys. `t(variable)` and
  // `t(`x.${y}`)` are invisible to it, so the number of such calls is pinned: if
  // they spread, this says so instead of the check quietly covering less. The
  // families behind them have their own tests (auditWords, portWords,
  // nodeCardPlural, ...); which calls those cover was not measured, so the
  // ceiling is one number. It only goes down.
  const DYNAMIC_CALLS = 191;
  const dynamic = /\bt\(\s*[^'\s)]/g;

  it('counts the dynamic t() calls and lets the number only fall', () => {
    let calls = 0;
    for (const [, code] of sources) calls += [...code.matchAll(dynamic)].length;
    expect(calls).toBeLessThanOrEqual(DYNAMIC_CALLS);
  });
});

describe('prose that never became a key', () => {
  // A literal typed into JSX renders as-is in both languages and has no key for
  // the parity checks to see. Cyrillic is the half a machine can find without
  // judgement: a Russian string in a screen with no `t()` around it is wrong for
  // the English operator. Comments hold Russian everywhere and are stripped first.
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<![:'"`\\])\/\/[^\n]*/g, '');

  /** A language names itself in its own language, or its switcher is unusable. */
  const ALLOWED = new Set(['Русский']);

  const screens = Object.entries(FILES).filter(
    ([path]) => /^\/src\/(contours|ui|app)\//.test(path) && path.endsWith('.tsx') && !path.endsWith('.test.tsx'),
  );

  it('scans the screens at all', () => {
    expect(screens.length).toBeGreaterThan(180);
  });

  it('no screen renders Russian text the operator cannot switch away from', () => {
    const out: string[] = [];
    for (const [path, code] of screens) {
      for (const m of stripComments(code).matchAll(/[А-Яа-яЁё][^'"`\n<>{}]*/g)) {
        const text = m[0].trim();
        if (text.length > 1 && !ALLOWED.has(text)) out.push(`${path}: ${text}`);
      }
    }
    expect(out).toEqual([]);
  });
});
