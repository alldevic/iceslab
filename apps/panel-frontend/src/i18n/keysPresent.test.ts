import { describe, expect, it } from 'vitest';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';

/**
 * A-274: every literal key the code hands to `t('…')` has a string in both
 * locales. Three keys of the open-ports note went with the old node modal
 * (f4d35522) and the screen printed «nodes.form.exposureClean»; nothing
 * noticed, because a missing key is not an error, only a key on the screen.
 *
 * A plural key counts as present through its `_one` / `_other` forms. Keys
 * built at run time (template literals) are not literals and are not read
 * here; their families have their own tests.
 */
const FILES = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const at = (d: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), d);
const has = (d: unknown, key: string) =>
  typeof at(d, key) === 'string' || typeof at(d, `${key}_one`) === 'string' || typeof at(d, `${key}_other`) === 'string';

describe('A-274: ключи t() из кода есть в обеих локалях', () => {
  it('каждый литеральный ключ находится в ru и en', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const [path, code] of Object.entries(FILES)) {
      if (path.includes('/i18n/') || /\.test\.tsx?$/.test(path)) continue;
      // t('a.b.c' or t("a.b.c"; a key has a dot and no spaces.
      for (const m of code.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+)['"]/g)) {
        seen += 1;
        const key = m[1]!;
        if (!has(ru, key)) missing.push(`ru ${key} (${path})`);
        if (!has(en, key)) missing.push(`en ${key} (${path})`);
      }
    }
    expect(seen).toBeGreaterThan(500);
    expect(missing).toEqual([]);
  });
});
