import { describe, expect, it } from 'vitest';
import { backendSource, outsideFrontendFilter } from '@/test-support/backendSource';
import { interfaceFields, zodObjectKeys } from '@/test-support/declarations';
import settingsSource from './settings.ts?raw';

/**
 * The settings the panel can save, and the settings the backend will accept.
 *
 * `PUT /api/settings` parses its body with a zod object, and a zod object
 * STRIPS what it does not declare. A key this side sends and that side has
 * never heard of does not 400: the save succeeds, the operator sees a green
 * toast, and nothing was written. The reverse direction is a setting the
 * backend reads that no control can set.
 *
 * Read off both sources as text, not exercised: there is no request that would
 * reveal a stripped key. Where the schema lives is these two constants and
 * nothing else. (settings.forms.test.tsx runs a saved form through the real
 * schema; this one is the direction a form that never sends a key cannot show.)
 */
const SCHEMA_FILE = 'settings/settings.schemas.ts';
const SCHEMA_CONST = 'UpdateSettingsSchema';

/**
 * Keys one side has and the other does not ON PURPOSE, each with the reason. A
 * waiting room, not a verdict; asserted in both directions so an excuse cannot
 * outlive its subject.
 */
const KNOWN_ONE_SIDED: Record<string, string> = {};

const front = () => interfaceFields(settingsSource, 'UpdateSettingsInput');
const back = () => zodObjectKeys(backendSource(SCHEMA_FILE), SCHEMA_CONST);

describe('the settings the panel sends are the settings the backend accepts', () => {
  it('reads both declarations', () => {
    // The control: an extraction that returned nothing would make every
    // comparison below vacuously true.
    expect(front().length, 'UpdateSettingsInput parsed to no fields').toBeGreaterThan(5);
    expect(back().length, `${SCHEMA_CONST} parsed to no keys`).toBeGreaterThan(5);
    expect(front()).toContain('brandName');
    expect(back()).toContain('brandName');
  });

  it('sends nothing the backend would silently strip', () => {
    const known = new Set(back());
    expect(
      front().filter((k) => !known.has(k) && !(k in KNOWN_ONE_SIDED)).sort(),
      'the panel can send these and zod drops them: the save returns ok and writes nothing',
    ).toEqual([]);
  });

  it('offers everything the backend accepts', () => {
    const offered = new Set(front());
    expect(
      back().filter((k) => !offered.has(k) && !(k in KNOWN_ONE_SIDED)).sort(),
      'the backend validates and applies these, and no control in the panel can set them',
    ).toEqual([]);
  });

  it('keeps no excuse for a key that is on both sides, or on neither', () => {
    const f = new Set(front());
    const b = new Set(back());
    const stale = Object.keys(KNOWN_ONE_SIDED).filter((k) => (f.has(k) && b.has(k)) || (!f.has(k) && !b.has(k)));
    expect(stale.sort()).toEqual([]);
  });

  it('the file with the schema starts the frontend CI job when edited', () => {
    expect(outsideFrontendFilter([SCHEMA_FILE])).toEqual([]);
  });
});
