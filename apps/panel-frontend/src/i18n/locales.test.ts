import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en';
import ru from './locales/ru';

/**
 * The panel has no other guard on its translations. i18next falls back to
 * printing the key itself when one is missing, so a locale that drifts shows
 * `profiles.form.cfg.pqNeedsSeed` in the UI and nothing fails — not the build,
 * not the types, not a review that did not happen to open that tab in that
 * language.
 */
function flatten(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * i18next spells plurals as sibling keys - `nodes_one`, `nodes_other`, and in
 * Russian also `_few` / `_many`. So the two locales are NOT supposed to hold
 * the same raw keys: ru carries forms en has no grammar for. What has to match
 * is the FAMILY each key belongs to, which is the name the code actually asks
 * for.
 */
const PLURAL = /_(zero|one|two|few|many|other)$/;
const family = (k: string): string => k.replace(PLURAL, '');

const enKeys = new Set(flatten(en));
const ruKeys = new Set(flatten(ru));
const enFamilies = new Set([...enKeys].map(family));
const ruFamilies = new Set([...ruKeys].map(family));

/** A key the code asks for resolves if it is there, or if its plural forms are. */
const resolves = (keys: Set<string>, families: Set<string>, k: string): boolean =>
  keys.has(k) || families.has(k);

describe('locale parity', () => {
  it('ru covers every key family en has', () => {
    expect([...enFamilies].filter((k) => !ruFamilies.has(k)).sort()).toEqual([]);
  });

  it('en covers every key family ru has', () => {
    expect([...ruFamilies].filter((k) => !enFamilies.has(k)).sort()).toEqual([]);
  });

  it('a plural key never comes alone: `_other` is the fallback every language needs', () => {
    const lonely = (keys: Set<string>) =>
      [...keys]
        .filter((k) => PLURAL.test(k))
        .map(family)
        .filter((f, i, a) => a.indexOf(f) === i)
        .filter((f) => !keys.has(`${f}_other`))
        .sort();
    expect(lonely(enKeys)).toEqual([]);
    expect(lonely(ruKeys)).toEqual([]);
  });

  it('no key is left holding a non-string', () => {
    // A key whose value is an object means someone nested under a leaf; a
    // number or null means a typo. Either renders as [object Object] or blank.
    const nonStrings = (o: unknown, prefix = ''): string[] => {
      if (o !== null && typeof o === 'object') {
        return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
          nonStrings(v, prefix ? `${prefix}.${k}` : k),
        );
      }
      return typeof o === 'string' ? [] : [prefix];
    };
    expect(nonStrings(en)).toEqual([]);
    expect(nonStrings(ru)).toEqual([]);
  });
});

/** Every source file under src/, so the scan cannot miss a new component. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const SRC = join(import.meta.dirname, '..');

describe('every translation the code asks for exists', () => {
  // Only literal keys can be checked. A key built at runtime - `t(\`x.${y}\`)`
  // or `t(someVariable)` - is invisible here by construction, so the count is
  // asserted too: if dynamic keys start spreading, this test says so instead of
  // quietly covering less.
  //
  // The second pattern deliberately catches the plain-identifier form as well.
  // It used to match backticks only, which meant a component that moved its
  // messages into a rules module and called `t(key)` dropped those keys out of
  // the scan without moving the counter - covering less while still looking
  // green. Anything it counts needs a test of its own; lib/pq-pairs.test.ts is
  // the pattern.
  const literal = /\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g;
  const dynamic = /\bt\(\s*[^'\s)]/g;

  const used = new Map<string, string>();
  let dynamicCalls = 0;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(literal)) used.set(m[1], file);
    dynamicCalls += [...text.matchAll(dynamic)].length;
  }

  it('finds keys to check at all (the scan itself has to work)', () => {
    expect(used.size).toBeGreaterThan(100);
  });

  it('resolves every literal key against en', () => {
    const missing = [...used.entries()]
      .filter(([k]) => !resolves(enKeys, enFamilies, k))
      .map(([k, f]) => `${k}  (${f.replace(SRC, 'src')})`)
      .sort();
    expect(missing).toEqual([]);
  });

  it('resolves every literal key against ru', () => {
    const missing = [...used.entries()]
      .filter(([k]) => !resolves(ruKeys, ruFamilies, k))
      .map(([k, f]) => `${k}  (${f.replace(SRC, 'src')})`)
      .sort();
    expect(missing).toEqual([]);
  });

  it('records how many keys are built dynamically and so go unchecked', () => {
    // 43 today. Widening the pattern to the identifier form added three that
    // the old backtick-only scan never saw; the ceiling moved with it rather
    // than the pattern being narrowed back to keep the number.
    expect(dynamicCalls).toBeLessThanOrEqual(45);
  });
});

/**
 * Prose that never became a key.
 *
 * Everything above compares the two locale files, or checks that a key the code
 * asks for exists. Neither can see a string the code never asked for: a literal
 * typed straight into JSX renders as-is in both languages, and it is invisible
 * to key parity because it has no key.
 *
 * Found by mounting the components for the first time (2026-08-28):
 * TestConnectModal was entirely untranslated — nine strings, one of them a
 * Russian "Закрыть" button an English operator read — and HostsManager's host
 * form carried ten more, one of which shipped the internal words "slice 30.1"
 * as a field description.
 *
 * Cyrillic is the half of this that a machine can find without judgement: an
 * English literal is at least the right language for one of the two audiences,
 * a Russian one in a file with no `t()` around it is not. The other half — 130
 * literal `label=` / `placeholder=` / `description=` props across the app — is
 * a measurement, not a rule, and is left to a decision rather than asserted
 * here.
 *
 * Read off the SOURCE rather than off a render, because a render only reaches
 * the branches it happens to take: the mount sweep in
 * `components/components.empty.test.tsx` asks the same question of what is on
 * screen and would not have seen the host form, which opens on a click.
 */
describe('prose that never became a key', () => {
  const SCAN = ['pages', 'components'].map((d) => join(import.meta.dirname, '..', d));

  /** Comments hold Russian all over this codebase and are none of this test's
   *  business. Stripped first — the same rule every source-level mirror here
   *  follows, and the one that keeps a check from agreeing with prose ABOUT the
   *  code instead of the code. JSX comments are `{/* ... *\/}`, so the block
   *  form covers them and the leftover braces carry no Cyrillic. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /** A language names itself in its own language, or its switcher is unusable. */
  const ALLOWED = new Set(['Русский']);

  function offenders(): string[] {
    const out: string[] = [];
    for (const dir of SCAN) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
        const src = stripComments(readFileSync(join(dir, file), 'utf8'));
        for (const m of src.matchAll(/[А-Яа-яЁё][^'"`\n<>{}]*/g)) {
          const text = m[0].trim();
          if (text.length > 1 && !ALLOWED.has(text)) out.push(`${file}: ${text}`);
        }
      }
    }
    return out;
  }

  it('scans the screens at all', () => {
    // The control: an empty scan would make the assertion below vacuous, and
    // "found nothing" is also what a moved directory looks like.
    const files = SCAN.flatMap((d) => readdirSync(d)).filter((f) => f.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(30);
  });

  it('no screen renders Russian text the operator cannot switch away from', () => {
    expect(offenders()).toEqual([]);
  });
});

