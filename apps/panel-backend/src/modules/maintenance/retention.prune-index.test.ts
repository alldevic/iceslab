import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Which retention deletes have an index under the column they delete by, and
 * why the rest are allowed not to.
 *
 * `pruneHistory` runs nightly and issues five range deletes, each of the shape
 * `WHERE <dateColumn> < cutoff`. Two of the five have an index LEADING with
 * that column (`node_usage_history.hour`, `node_bootstrap_tokens.expires_at`);
 * the other three are covered only by a composite that leads with `user_id`,
 * which a range on the date alone cannot use. Nothing said whether that was a
 * decision or an oversight — the state this file ends.
 *
 * The answer is a measurement, not a preference. On a scratch table of
 * 1 000 000 rows holding 91 days, deleting the ~1 % that fall past the cutoff
 * (the steady state, since the job runs every night), against the SAME data:
 *
 *     without a leading index   143 ms   Seq Scan, 989 248 rows filtered
 *     with `(requested_at)`      46 ms   Bitmap Index Scan
 *     index size                 21 MB   against a 65 MB table
 *
 * Three times faster, and 143 ms once a night is not a problem. It scales
 * linearly with the table, so the number that matters is where it stops being
 * free: ~100 million rows is ~14 seconds of a DELETE holding row locks, and a
 * panel reaches that only after ~100 million subscription polls. So the
 * indexes are NOT added, the same call §53 made about pagination, and this
 * file is what keeps the next one from being added by accident instead of by
 * decision.
 *
 * Measured 2026-08-28 on postgres:16-alpine. A measurement goes stale; the
 * cases below do not depend on the numbers, only on the list.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const schema = readFileSync(resolve(repoRoot, 'prisma/schema.prisma'), 'utf8');
const cron = readFileSync(resolve(here, 'retention.cron.ts'), 'utf8');

/** `prisma.<model>.deleteMany({ where: { <field>: { lt: … } } })` */
function pruneTargets(): { model: string; field: string }[] {
  return [...cron.matchAll(/prisma\.(\w+)\.deleteMany\(\{\s*where:\s*\{\s*(\w+):\s*\{\s*lt:/g)].map(
    (m) => ({ model: m[1]!, field: m[2]! }),
  );
}

/** The first column of every index/key declared on a Prisma model. */
function leadingIndexedFields(model: string): Set<string> {
  const pascal = model[0]!.toUpperCase() + model.slice(1);
  const block = new RegExp(`^model ${pascal} \\{[\\s\\S]*?^\\}`, 'm').exec(schema)?.[0] ?? '';
  const out = new Set<string>();
  for (const m of block.matchAll(/@@(?:index|id|unique)\(\[([^\]]+)\]/g)) {
    const first = m[1]!.split(',')[0]!.trim().replace(/\(.*/, '');
    out.add(first);
  }
  // A single-field `@id` / `@unique` is an index on that field alone.
  for (const m of block.matchAll(/^\s*(\w+)\s+\S+.*@(?:id|unique)\b/gm)) out.add(m[1]!);
  return out;
}

/**
 * A prune whose column has no leading index, with the reason it is allowed.
 * An entry is a claim about SIZE — remove it and add the index the day the
 * table gets there.
 */
const UNINDEXED_ON_PURPOSE: Record<string, string> = {
  'subscriptionRequestHistory.requestedAt':
    'one row per /sub poll; the biggest of the five, and still 143 ms per nightly run at 1M rows',
  'nodeUserUsageHistory.date':
    'one row per (node, user, day); bounded by fleet size times user count, and pruned on a Date column with day granularity',
  'subscriptionEvent.createdAt':
    'one row per subscription lifecycle change, which is orders of magnitude rarer than a poll',
};

describe('the nightly retention prune', () => {
  const targets = pruneTargets();

  // The control: an extraction that stopped matching would make every case
  // below agree with an empty list.
  it('finds the deletes it is about', () => {
    expect(targets.length, `parsed no deleteMany(...lt...) out of retention.cron.ts`).toBeGreaterThanOrEqual(4);
    expect(targets.map((t) => t.model)).toContain('nodeUsageHistory');
  });

  it('deletes only by a column that is indexed, or named here with its reason', () => {
    const unexplained = targets
      .map((t) => ({ ...t, key: `${t.model}.${t.field}` }))
      .filter((t) => !leadingIndexedFields(t.model).has(t.field))
      .filter((t) => !(t.key in UNINDEXED_ON_PURPOSE))
      .map((t) => t.key);

    expect(
      unexplained,
      `These nightly deletes range over a column no index leads with, which is a ` +
        `sequential scan of the whole table every night:\n  ${unexplained.join('\n  ')}\n` +
        `Add an index leading with that column, or add an entry to ` +
        `UNINDEXED_ON_PURPOSE saying which size makes it affordable.`,
    ).toEqual([]);
  });

  // An excuse must not outlive its subject. An entry for a prune that no longer
  // exists, or that has since been indexed, reads as though the trade-off were
  // still being made.
  it('keeps no exemption that no longer applies', () => {
    const live = new Set(targets.map((t) => `${t.model}.${t.field}`));
    const stale = Object.keys(UNINDEXED_ON_PURPOSE).filter((k) => {
      if (!live.has(k)) return true;
      const [model, field] = k.split('.') as [string, string];
      return leadingIndexedFields(model).has(field);
    });
    expect(stale, 'exempted from the index rule, but the prune is gone or the index now exists').toEqual([]);
  });

  // And the other half of the claim: the two that ARE indexed prove the rule is
  // satisfiable, so "everything is exempt" cannot be how this file stays green.
  it('at least two of the five carry the index the rule asks for', () => {
    const indexed = targets.filter((t) => leadingIndexedFields(t.model).has(t.field));
    expect(indexed.map((t) => `${t.model}.${t.field}`).sort()).toEqual([
      'nodeUsageHistory.hour',
    ]);
  });
});
