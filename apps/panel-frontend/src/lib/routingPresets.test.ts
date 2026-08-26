import { describe, expect, it } from 'vitest';
import { ROUTING_PRESET_IDS, presetKey } from './routingPresets';
import en from '../i18n/locales/en';
import ru from '../i18n/locales/ru';

/**
 * `presetKey` turns a routing-preset id into the suffix of the i18n key that
 * names it on screen — `metadata.preset${presetKey(id)}` and its `…Hint`. Two
 * things make it worth its own file despite being one line:
 *
 *   - the keys it builds are DYNAMIC, so the locale scan cannot see them. That
 *     scan reads literal `t('a.b')` only and counts what it misses, and the
 *     comment in it says anything counted needs a test of its own. A key that
 *     does not resolve renders as itself: the user's routing preset column
 *     shows `metadata.presetRuSplit` instead of a sentence.
 *   - it ends in a fallback. A fourth preset added to the shared list — which
 *     the backend would accept, since it validates against the same list —
 *     falls through to 'ProxyAll' and is labelled "Everything through the
 *     tunnel" in the UI. Silently: the id is valid, the key resolves, the copy
 *     is simply about a different preset. That is worse than a missing string,
 *     which at least looks broken.
 */

const resolve = (bundle: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((o, part) => {
    if (o === null || typeof o !== 'object') return undefined;
    return (o as Record<string, unknown>)[part];
  }, bundle);

describe('presetKey', () => {
  it('has presets to key at all', () => {
    // The control: an empty id list would make every case below pass by having
    // nothing to check.
    expect(ROUTING_PRESET_IDS.length).toBeGreaterThanOrEqual(3);
  });

  it('gives every preset its own name', () => {
    // Two presets sharing a suffix is two rows of the same sentence in the UI,
    // and the fallback makes that the DEFAULT outcome for anything new.
    const keys = ROUTING_PRESET_IDS.map(presetKey);
    expect(new Set(keys).size, `two presets share a label: ${keys.join(', ')}`).toBe(keys.length);
  });

  it.each(ROUTING_PRESET_IDS)('%s resolves to a title and a hint in both locales', (id) => {
    for (const [name, bundle] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const title = `metadata.preset${presetKey(id)}`;
      expect(typeof resolve(bundle, title), `${name} is missing ${title}`).toBe('string');
      expect(typeof resolve(bundle, `${title}Hint`), `${name} is missing ${title}Hint`).toBe(
        'string',
      );
    }
  });

  // The fallback is a real branch, not dead code: it is what an id outside the
  // list gets. Pinned so that the day a fourth preset lands, this file says
  // which sentence it silently borrowed.
  it('falls back to ProxyAll for an id it does not know', () => {
    expect(presetKey('something-new-tomorrow' as never)).toBe('ProxyAll');
  });
});
