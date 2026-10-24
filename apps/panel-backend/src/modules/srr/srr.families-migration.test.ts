import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';

/**
 * A-236 step 4: the migration that moves the seeded User-Agent rules to the
 * core families and gives a rule its template_name, run as its file says,
 * forward and back (the A-143 pattern). The statements and the rollback are
 * read out of migration.sql; everything runs in one transaction rolled back at
 * the end, so the shared test database is left as it was.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261024183834_srr_core_families/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

function split(text: string): string[] {
  return text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const forward = split(
  sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n'),
);

const rollback = (() => {
  const lines = sql.split(/\r?\n/);
  const start = lines.findIndex((l) => /^--\s*Rollback:/i.test(l));
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('--   ')) break;
    body.push(l.slice('--   '.length));
  }
  return split(body.join('\n')).filter((s) => !s.includes('_prisma_migrations'));
})();

class Rollback extends Error {}
type Tx = typeof prisma;

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function formats(t: Tx): Promise<Record<string, string>> {
  const rows = await t.$queryRawUnsafe<{ name: string; format: string }[]>(
    'SELECT "name", "format" FROM "subscription_response_rules" ORDER BY "name"',
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.format]));
}

async function hasColumn(t: Tx): Promise<boolean> {
  const rows = await t.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'subscription_response_rules' AND column_name = 'template_name'`,
  );
  return rows[0]!.n === 1;
}

describe('20261024183834_srr_core_families', () => {
  it('reads its own statements: two forward, three back', () => {
    expect(forward).toHaveLength(2);
    expect(rollback).toHaveLength(3);
    expect(rollback[2]).toContain('DROP COLUMN "template_name"');
  });

  it('moves the seeded rows to mihomo and stash and back, and leaves an operator edit alone', async () => {
    const seen: Record<string, unknown> = {};
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as Tx;
        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.columnAfterBack = await hasColumn(t);
        await t.$executeRawUnsafe('DELETE FROM "subscription_response_rules"');
        // The seeds as 20260923131631 left them, an operator's edited Clash
        // pattern under another name, and an operator's own Stash-like rule.
        await t.$executeRawUnsafe(`
          INSERT INTO "subscription_response_rules" ("id", "name", "ua_pattern", "format", "priority", "updated_at") VALUES
            (gen_random_uuid(), 'Clash', '(?i)clash|mihomo', 'clash', 40, now()),
            (gen_random_uuid(), 'NekoBox/NekoRay', 'NekoBox|NekoRay', 'clash', 20, now()),
            (gen_random_uuid(), 'Stash', '(?i)stash', 'clash', 45, now()),
            (gen_random_uuid(), 'My Clash', '(?i)clashx', 'clash', 35, now()),
            (gen_random_uuid(), 'Hiddify', 'Hiddify', 'singbox', 10, now())`);
        seen.before = await formats(t);

        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forward = await formats(t);
        seen.columnAfterForward = await hasColumn(t);

        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.back = await formats(t);

        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.again = await formats(t);
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.columnAfterBack).toBe(false);
    expect(seen.columnAfterForward).toBe(true);
    const old = { Clash: 'clash', 'NekoBox/NekoRay': 'clash', Stash: 'clash', 'My Clash': 'clash', Hiddify: 'singbox' };
    const families = { Clash: 'mihomo', 'NekoBox/NekoRay': 'mihomo', Stash: 'stash', 'My Clash': 'clash', Hiddify: 'singbox' };
    expect(seen.before).toEqual(old);
    expect(seen.forward).toEqual(families);
    expect(seen.back).toEqual(old);
    expect(seen.again).toEqual(families);
    // Left as it was: the column is there.
    expect(await hasColumn(prisma)).toBe(true);
  });
});
