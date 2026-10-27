import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * One profile on several ports of a node (25.10): the migration that drops
 * the (profile, node) constraint, run as its file says: forward, the header's
 * rollback, forward again. In one transaction rolled back at the end
 * (Postgres DDL is transactional), so the shared test database is left as it
 * was whatever fails in between.
 */
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261025164819_binding_many_ports/migration.sql',
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

const hasPairKey = async (t: typeof prisma) =>
  (
    await t.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'profile_node_bindings_profile_id_node_id_key'`,
    )
  )[0]!.n === 1;

describe('20261025164819_binding_many_ports', () => {
  it('reads its own statements: one forward, one back', () => {
    expect(forward).toEqual([
      'ALTER TABLE "profile_node_bindings" DROP CONSTRAINT "profile_node_bindings_profile_id_node_id_key"',
    ]);
    expect(rollback).toEqual([
      'ALTER TABLE "profile_node_bindings"\n  ADD CONSTRAINT "profile_node_bindings_profile_id_node_id_key" UNIQUE ("profile_id", "node_id")',
    ]);
  });

  it('runs back and forward again from the applied state', async () => {
    const seen: boolean[] = [];
    await expect(
      prisma.$transaction(
        async (tx) => {
          const t = tx as unknown as typeof prisma;
          seen.push(await hasPairKey(t)); // dropped by migrate deploy
          for (const s of rollback) await t.$executeRawUnsafe(s);
          seen.push(await hasPairKey(t));
          for (const s of forward) await t.$executeRawUnsafe(s);
          seen.push(await hasPairKey(t));
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(seen).toEqual([false, true, false]);
    expect(await hasPairKey(prisma)).toBe(false);
  });
});
