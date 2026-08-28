// Every table the nightly sweep deletes from, against the index that has to
// serve it.
//
// `pruneHistory` deletes by AGE alone — `WHERE requested_at < X` and three
// siblings — and three of the four tables had no index leading with the age
// column. Their composites lead with `user_id`, which cannot serve a predicate
// that does not mention a user. Measured on 1M rows before the indexes were
// added, in the steady state the cron actually runs in (a table pruned
// yesterday, ~11k rows over the horizon):
//
//   seq scan            110.2 ms
//   bitmap index scan     4.6 ms
//
// And measured for the case that does NOT want one: the first sweep of a
// long-unpruned table deletes ~25% of it, where a seq scan is the right plan
// (235 ms, and the planner would not have used an index). The index is for
// every night after that first one — which is every night.
//
// The fourth table, node_usage_history, already had `(hour DESC)`. It was added
// for the dashboard, and it is the only one of the four that happened to serve
// the sweep as well — an accident, not a decision, which is exactly why the
// other three went unnoticed.
//
// So the pairing is checked rather than remembered: a fifth retention table, or
// a sweep repointed at a different column, fails here instead of quietly
// seq-scanning a growing table every night.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRON = resolve(HERE, './retention.cron.ts');
const SCHEMA = resolve(HERE, '../../../prisma/schema.prisma');

/** Source with comments cut out: a mirror that reads them answers about prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The (prisma model, field) pairs the sweep deletes by, read off the cron
 * rather than listed here.
 */
function sweptBy(): Array<{ model: string; field: string }> {
  const src = code(CRON);
  const out: Array<{ model: string; field: string }> = [];
  const re = /prisma\.(\w+)\.deleteMany\(\{\s*where:\s*\{\s*(\w+):\s*\{\s*lt:/g;
  for (const m of src.matchAll(re)) out.push({ model: m[1]!, field: m[2]! });
  return out;
}

/** Every `@@index([...])` of a model, as the list of column names it leads with. */
function indexesOf(model: string): string[][] {
  const src = code(SCHEMA);
  const at = src.search(new RegExp(`^model ${model[0]!.toUpperCase()}${model.slice(1)} \\{`, 'm'));
  expect(at, `no model in schema.prisma for prisma.${model}`).toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf('\n}', at));
  return [...block.matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) =>
    m[1]!.split(',').map((c) => c.trim().replace(/\(.*\)$/, '')),
  );
}

describe('the nightly retention sweep has an index for every table it sweeps', () => {
  const swept = sweptBy();

  it('found the sweeps at all', () => {
    // The control: a regex that matched nothing would make every case below
    // vacuously true.
    expect(swept.length, 'the deleteMany calls could not be read off retention.cron.ts').toBe(4);
  });

  for (const { model, field } of sweptBy()) {
    it(`${model}: an index leads with ${field}`, () => {
      const leads = indexesOf(model).map((cols) => cols[0]);
      expect(
        leads,
        `the sweep deletes ${model} by ${field} alone, and no index leads with it: a composite keyed on something else cannot serve that predicate, so every night is a seq scan over a growing table`,
      ).toContain(field);
    });
  }
});
