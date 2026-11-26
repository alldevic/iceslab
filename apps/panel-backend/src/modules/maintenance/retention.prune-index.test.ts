import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Which retention deletes have an index under the column they delete by, and
 * why the rest are allowed not to.
 *
 * `pruneHistory` runs nightly and issues range deletes of the shape
 * `WHERE <dateColumn> < cutoff`. A range on a column no index leads with is a
 * sequential scan of the whole table every night. Whether that is acceptable is
 * a question of table size, so each unindexed column is listed below with the
 * reason it is affordable; a new prune on an unlisted, unindexed column fails
 * here until someone decides.
 *
 * The fork measured it on 1 000 000 rows (91 days of data, ~1 % past the cutoff):
 * 143 ms with a seq scan against 46 ms with a leading index (21 MB on a 65 MB
 * table); linear in table size, ~14 s at 100 million rows. Not re-measured for
 * this base; the cases below do not depend on the numbers, only on the list.
 *
 * The deletes are read out of the source, so the list cannot drift from the job:
 *   - retention.cron.ts: `deleteMany` and the `findMany` that selects the users
 *     to erase, both `where: { <field>: { lt: ... } }`;
 *   - bootstrap.service.ts: `purgeExpiredBootstrapTokens` (`expiresAt` / `consumedAt`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '../../..');
const modelsDir = resolve(backendRoot, 'prisma/models');
const schema = readdirSync(modelsDir)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(resolve(modelsDir, f), 'utf8'))
  .join('\n');
const cron = readFileSync(resolve(here, 'retention.cron.ts'), 'utf8');
const bootstrap = readFileSync(resolve(here, '../nodes/bootstrap.service.ts'), 'utf8');

function pruneTargets(): { model: string; field: string }[] {
  const fromCron = [
    ...cron.matchAll(/prisma\.(\w+)\.(?:deleteMany|findMany)\(\{\s*where:\s*\{\s*(\w+):\s*\{\s*lt:/g),
  ].map((m) => ({ model: m[1]!, field: m[2]! }));
  const fromBootstrap = [
    ...bootstrap.matchAll(/prisma\.(\w+)\.deleteMany\(\{\s*where:\s*\{\s*OR:\s*\[\{\s*(\w+):\s*\{\s*lt:/g),
  ].map((m) => ({ model: m[1]!, field: m[2]! }));
  return [...fromCron, ...fromBootstrap];
}

/** The first column of every index/key declared on a Prisma model. */
function leadingIndexedFields(model: string): Set<string> {
  const pascal = model[0]!.toUpperCase() + model.slice(1);
  const block = new RegExp(`^model ${pascal} \\{[\\s\\S]*?^\\}`, 'm').exec(schema)?.[0] ?? '';
  const out = new Set<string>();
  for (const m of block.matchAll(/@@(?:index|id|unique)\(\[([^\]]+)\]/g)) {
    out.add(m[1]!.split(',')[0]!.trim().replace(/\(.*/, ''));
  }
  // A single-field `@id` / `@unique` is an index on that field alone.
  for (const m of block.matchAll(/^\s*(\w+)\s+\S+.*@(?:id|unique)\b/gm)) out.add(m[1]!);
  return out;
}

/**
 * A prune whose column has no leading index, with the reason it is allowed.
 * An entry is a claim about SIZE: remove it and add the index the day the
 * table gets there.
 */
const UNINDEXED_ON_PURPOSE: Record<string, string> = {
  'subscriptionRequestHistory.requestedAt':
    'one row per /sub poll; the biggest table, and still ~143 ms per nightly run at 1M rows (fork measurement)',
  'nodeUserUsageHistory.date':
    'one row per (node, user, day); bounded by fleet size times user count, and a Date column with day granularity',
  'subscriptionEvent.createdAt':
    'one row per admin action or status flip, orders of magnitude rarer than a poll',
  'hwidUserDevice.lastSeenAt':
    'one row per registered device; bounded by users times the device limit, and a delete frees slots rather than growing a log',
};

describe('the nightly retention prune', () => {
  const targets = pruneTargets();
  const key = (t: { model: string; field: string }) => `${t.model}.${t.field}`;

  // The control: an extraction that stopped matching would make every case
  // below agree with an empty list.
  it('finds the deletes it is about', () => {
    const keys = targets.map(key);
    expect(targets.length, 'parsed too few range deletes out of retention.cron.ts').toBeGreaterThanOrEqual(8);
    for (const k of [
      'subscriptionRequestHistory.requestedAt',
      'nodeUserUsageHistory.date',
      'nodeUsageHistory.hour',
      'subscriptionEvent.createdAt',
      'user.deletedAt',
      'hwidUserDevice.lastSeenAt',
      'adminAuditEvent.at',
      'nodeBootstrapToken.expiresAt',
    ]) {
      expect(keys, `${k} is no longer found in the prune source`).toContain(k);
    }
  });

  it('deletes only by a column that is indexed, or named here with its reason', () => {
    const unexplained = targets
      .filter((t) => !leadingIndexedFields(t.model).has(t.field))
      .map(key)
      .filter((k) => !(k in UNINDEXED_ON_PURPOSE));

    expect(
      unexplained,
      `These nightly deletes range over a column no index leads with, which is a ` +
        `sequential scan of the whole table every night:\n  ${unexplained.join('\n  ')}\n` +
        `Add an index leading with that column, or add an entry to ` +
        `UNINDEXED_ON_PURPOSE saying which size makes it affordable.`,
    ).toEqual([]);
  });

  // An excuse must not outlive its subject.
  it('keeps no exemption that no longer applies', () => {
    const live = new Set(targets.map(key));
    const stale = Object.keys(UNINDEXED_ON_PURPOSE).filter((k) => {
      if (!live.has(k)) return true;
      const [model, field] = k.split('.') as [string, string];
      return leadingIndexedFields(model).has(field);
    });
    expect(stale, 'exempted from the index rule, but the prune is gone or the index now exists').toEqual([]);
  });

  // The other half of the claim: some deletes DO carry the index, so
  // "everything is exempt" cannot be how this file stays green.
  it('the indexed deletes are the ones the rule expects', () => {
    const indexed = targets.filter((t) => leadingIndexedFields(t.model).has(t.field)).map(key);
    expect(indexed.sort()).toEqual(['adminAuditEvent.at', 'nodeBootstrapToken.expiresAt', 'nodeUsageHistory.hour', 'user.deletedAt']);
  });
});
