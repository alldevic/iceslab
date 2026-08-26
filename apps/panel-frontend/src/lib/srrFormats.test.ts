import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRR_FORMATS, CASCADE_AWARE_FORMATS, formatTone } from './srrFormats';

/**
 * `SRR_FORMATS` is the third hand-written list of subscription format names in
 * this repository, and its own comment says what it is: "the SRR enum from
 * srr.schemas.ts, not the wider set /sub?format= accepts". A comment is not a
 * check, and the other two lists of this kind had already drifted apart in
 * both directions by the time anyone looked (see the host format gate).
 *
 * Both directions cost, and unlike the api.ts mirror neither is tolerable:
 *
 *   - a format offered here and absent from the schema is a picker entry that
 *     answers 400 on save. The operator chose something the panel showed them.
 *   - a format the schema accepts and absent here is a delivery rule that
 *     cannot be created from the UI at all, silently — the feature simply
 *     appears not to exist.
 *
 * The ORDER is deliberately not compared: this list is the order the picker
 * lists them in, which is a UI decision, while the schema's order is
 * arbitrary.
 */

const SCHEMA = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'panel-backend',
  'src',
  'modules',
  'srr',
  'srr.schemas.ts',
);

/** The `SrrFormat` enum members, read out of the backend source. */
function schemaFormats(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const m = /export const SrrFormat = z\.enum\(\[([^\]]*)\]\)/.exec(src);
  if (!m) throw new Error('SrrFormat enum not found in srr.schemas.ts');
  return [...m[1]!.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]!);
}

describe('the SRR format picker against the schema that stores it', () => {
  it('reads the enum at all', () => {
    // The control: a regex that matched nothing would make both comparisons
    // below compare a list against an empty one and fail loudly — or, if the
    // parse were made lenient, pass vacuously. Asserted so it can do neither.
    expect(schemaFormats().length).toBeGreaterThanOrEqual(10);
  });

  it('offers nothing the schema would refuse', () => {
    const schema = schemaFormats();
    const extra = SRR_FORMATS.filter((f) => !schema.includes(f));
    expect(extra, 'the picker offers formats a rule cannot be saved with').toEqual([]);
  });

  it('offers everything the schema accepts', () => {
    const missing = schemaFormats().filter((f) => !SRR_FORMATS.includes(f as never));
    expect(missing, 'a rule format exists in the API and cannot be picked in the UI').toEqual([]);
  });
});

describe('the rest of the module', () => {
  // `CASCADE_AWARE_FORMATS` decides where the UI says a balancer cascade
  // survives, and every member of it has to be a format a rule can actually
  // name — otherwise the hint is about a choice the picker does not offer.
  it('marks cascade-aware formats that the picker also offers', () => {
    expect(CASCADE_AWARE_FORMATS.length).toBeGreaterThan(0);
    for (const f of CASCADE_AWARE_FORMATS) {
      expect(SRR_FORMATS, `${f} is cascade-aware but not offered`).toContain(f);
    }
  });

  // The accent exists so one format reads the same in the table, the picker
  // and the tester. A colour is cosmetic; the same format wearing two of them
  // is not, because it is what tells an operator two rows are the same thing.
  it('gives one format one colour everywhere, and knows every format it lists', () => {
    for (const f of SRR_FORMATS) {
      expect(formatTone(f), f).toBe(formatTone(f));
      expect(formatTone(f), `${f} falls through to the unknown-format grey`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    // The fallback is a real branch: an unknown name must get the neutral grey
    // rather than borrow a family's accent.
    expect(formatTone('not-a-format')).toBe('#7A8BA3');
  });
});
