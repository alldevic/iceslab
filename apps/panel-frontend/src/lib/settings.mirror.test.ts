import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceFields } from '../test/declarations';

/**
 * The settings the panel can save, and the settings the backend will accept.
 *
 * `PUT /api/settings` parses its body with a zod object, and a zod object
 * STRIPS what it does not declare. So a key this side sends and that side has
 * never heard of does not 400 and does not warn: the request succeeds, the
 * response says `ok`, the operator sees a green toast, and nothing was written.
 * That is the same failure the seven dead env keys had — declared, offered,
 * inert — arriving through the other door, and the response body's `updated`
 * list is built from the PARSED input, so it agrees that nothing happened
 * without ever saying so.
 *
 * The reverse direction is the question this fork keeps forgetting to ask:
 * what does the backend read that nobody can set? It found one.
 * `subscriptionEntryPoolSize` was live — subscription.service.ts caps each
 * profile's node list with it — and no control anywhere in the panel sent it,
 * so an operator could only change it by writing the row by hand. It has a
 * field on the metadata page now, which is why the exception list below is
 * empty.
 *
 * Read off both sources rather than exercised, in the same instrument as
 * api.mirror.test.ts: the declarations ARE the contract, and there is no
 * request that would reveal a stripped key.
 */

const FRONT = join(import.meta.dirname, 'api.ts');
const BACK = join(
  import.meta.dirname, '..', '..', '..',
  // The schema moved out of settings.routes.ts into a module of its own on
  // 2026-08-29 (the convention every other module already followed), so the
  // panel-frontend round-trip door can import it without dragging prisma into
  // the frontend test env. This mirror reads the declaration, so it follows it.
  'panel-backend', 'src', 'modules', 'settings', 'settings.schemas.ts',
);

/**
 * Keys one side has and the other does not, ON PURPOSE, each with the reason.
 *
 * A waiting room, not a verdict. An entry here says the gap is known and its
 * resolution is somebody's decision; it does not say the gap is fine. The list
 * is asserted in both directions below so an excuse cannot outlive its subject.
 */
const KNOWN_ONE_SIDED: Record<string, string> = {};

/** Top-level keys of the zod object literal `UpdateSettingsSchema`. */
function zodKeys(src: string): string[] {
  const at = src.indexOf('export const UpdateSettingsSchema = z.object({');
  if (at < 0) throw new Error('UpdateSettingsSchema not found in settings.schemas.ts');
  const open = src.indexOf('{', src.indexOf('z.object(', at));
  const keys: string[] = [];
  let depth = 0;
  let line = '';
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1 && (ch === ',' || ch === '\n')) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m) keys.push(m[1]!);
      line = '';
    } else if (depth >= 1 && i > open) {
      line += ch;
    }
  }
  return [...new Set(keys)];
}

describe('the settings the panel sends are the settings the backend accepts', () => {
  // Half of this contract lives in the other package. When it is not there,
  // SAY so in the case name: a quietly-passing comparison of nothing is the
  // failure this file exists to prevent, and vitest swallows console output.
  const haveBack = existsSync(BACK);

  it(haveBack
    ? 'reads both declarations'
    : 'CROSS-REPO HALF NOT RUN: settings.routes.ts is not next to this checkout', () => {
    if (!haveBack) return;
    const front = interfaceFields(readFileSync(FRONT, 'utf8'), 'UpdateSettingsInput');
    const back = zodKeys(readFileSync(BACK, 'utf8'));
    // The control. Either extraction returning nothing would make every
    // comparison below vacuously true.
    expect(front.length, 'UpdateSettingsInput parsed to no fields').toBeGreaterThan(5);
    expect(back.length, 'UpdateSettingsSchema parsed to no keys').toBeGreaterThan(5);
    expect(front).toContain('brandName');
    expect(back).toContain('brandName');
  });

  it.runIf(haveBack)('sends nothing the backend would silently strip', () => {
    const front = interfaceFields(readFileSync(FRONT, 'utf8'), 'UpdateSettingsInput');
    const back = new Set(zodKeys(readFileSync(BACK, 'utf8')));
    const stripped = front.filter((k) => !back.has(k) && !(k in KNOWN_ONE_SIDED));
    expect(
      stripped.sort(),
      'the panel can send these and zod drops them: the save returns ok and writes nothing',
    ).toEqual([]);
  });

  it.runIf(haveBack)('offers everything the backend accepts', () => {
    const front = new Set(interfaceFields(readFileSync(FRONT, 'utf8'), 'UpdateSettingsInput'));
    const back = zodKeys(readFileSync(BACK, 'utf8'));
    const unreachable = back.filter((k) => !front.has(k) && !(k in KNOWN_ONE_SIDED));
    expect(
      unreachable.sort(),
      'the backend validates and applies these, and no control in the panel can set them',
    ).toEqual([]);
  });

  it.runIf(haveBack)('keeps no excuse for a key that is on both sides after all', () => {
    const front = new Set(interfaceFields(readFileSync(FRONT, 'utf8'), 'UpdateSettingsInput'));
    const back = new Set(zodKeys(readFileSync(BACK, 'utf8')));
    const stale = Object.keys(KNOWN_ONE_SIDED).filter((k) => front.has(k) && back.has(k));
    expect(stale.sort(), 'listed as one-sided, but both sides declare it now').toEqual([]);
  });

  it.runIf(haveBack)('keeps no excuse for a key neither side declares', () => {
    const front = new Set(interfaceFields(readFileSync(FRONT, 'utf8'), 'UpdateSettingsInput'));
    const back = new Set(zodKeys(readFileSync(BACK, 'utf8')));
    const gone = Object.keys(KNOWN_ONE_SIDED).filter((k) => !front.has(k) && !back.has(k));
    expect(gone.sort(), 'listed as one-sided, but neither side has it any more').toEqual([]);
  });
});
