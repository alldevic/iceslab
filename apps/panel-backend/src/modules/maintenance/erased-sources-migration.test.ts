import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * A-268 tombstone: the migration that adds erased_user_sources, run as its
 * file says: forward, the header's rollback, forward again, in one
 * transaction rolled back at the end, so the shared test database is left as
 * it was whatever fails in between.
 */
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261025225015_erased_user_sources/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

const split = (text: string) =>
  text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const forward = split(
  sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n'),
);

const rollback = (() => {
  const lines = sql.split(/\r?\n/);
  const start = lines.findIndex((l) => /^--\s*ROLLBACK/i.test(l));
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('--   ')) break;
    body.push(l.slice('--   '.length));
  }
  return split(body.join('\n')).filter((s) => !s.includes('_prisma_migrations'));
})();

class Rollback extends Error {}

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const hasTable = async (t: typeof prisma) =>
  (
    await t.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'erased_user_sources'`,
    )
  )[0]!.n === 1;

describe('20261025225015_erased_user_sources', () => {
  it('reads its own statements: one forward, one back', () => {
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatch(/^CREATE TABLE "erased_user_sources"/);
    expect(rollback).toEqual(['DROP TABLE "erased_user_sources"']);
  });

  it('runs back and forward again from the applied state', async () => {
    const seen: boolean[] = [];
    await expect(
      prisma.$transaction(
        async (tx) => {
          const t = tx as unknown as typeof prisma;
          seen.push(await hasTable(t));
          for (const s of rollback) await t.$executeRawUnsafe(s);
          seen.push(await hasTable(t));
          for (const s of forward) await t.$executeRawUnsafe(s);
          seen.push(await hasTable(t));
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(seen).toEqual([true, false, true]);
    expect(await hasTable(prisma)).toBe(true);
  });
});
