import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * The migration that adds users.numeric_id and users.external_squad_uuid, run
 * as its file says: forward, the header's rollback, forward again, in one
 * transaction rolled back at the end, so the shared test database is left as
 * it was whatever fails in between.
 */
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261027120000_remnawave_user_ids/migration.sql',
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

const columns = async (t: typeof prisma) =>
  (
    await t.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('numeric_id', 'external_squad_uuid')
        ORDER BY column_name`,
    )
  ).map((r) => r.column_name);

describe('20261027120000_remnawave_user_ids', () => {
  it('reads its own statements: three forward, two back', () => {
    expect(forward).toHaveLength(3);
    expect(rollback).toEqual([
      'ALTER TABLE "users" DROP COLUMN "external_squad_uuid"',
      'ALTER TABLE "users" DROP COLUMN "numeric_id"',
    ]);
  });

  it('runs back and forward again from the applied state, numbering existing rows', async () => {
    const seen: string[][] = [];
    let numbered: { n: number; distinct: number; nulls: number } | undefined;
    await expect(
      prisma.$transaction(
        async (tx) => {
          const t = tx as unknown as typeof prisma;
          // A row that exists before the column does, as on a filled database.
          await t.$executeRawUnsafe(
            `INSERT INTO users (id, short_id, username, subscription_token, hysteria_password,
               amneziawg_private_key, amneziawg_public_key, naive_password, xray_uuid, updated_at)
             VALUES (gen_random_uuid(), 'mig-rw-ids', 'mig_rw_ids', 'mig-rw-ids-token', 'h', 'a', 'b', 'n',
               gen_random_uuid(), now())`,
          );
          seen.push(await columns(t));
          for (const s of rollback) await t.$executeRawUnsafe(s);
          seen.push(await columns(t));
          for (const s of forward) await t.$executeRawUnsafe(s);
          seen.push(await columns(t));
          numbered = (
            await t.$queryRawUnsafe<{ n: number; distinct: number; nulls: number }[]>(
              `SELECT count(*)::int AS n, count(DISTINCT numeric_id)::int AS distinct,
                      count(*) FILTER (WHERE numeric_id IS NULL)::int AS nulls FROM users`,
            )
          )[0];
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);
    const both = ['external_squad_uuid', 'numeric_id'];
    expect(seen).toEqual([both, [], both]);
    expect(numbered!.n).toBeGreaterThan(0);
    expect(numbered!.distinct).toBe(numbered!.n);
    expect(numbered!.nulls).toBe(0);
    expect(await columns(prisma)).toEqual(both);
  });
});
