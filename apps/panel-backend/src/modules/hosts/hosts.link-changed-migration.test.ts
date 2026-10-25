import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * A-122: the migration that gives the four rows of a link their own stamp,
 * run as its file says, forward and back (the A-143 pattern); one transaction
 * rolled back at the end.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261024232932_link_changed_at/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

function split(text: string): string[] {
  return text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const forward = split(sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n'));

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
const TABLES = ['hosts', 'profile_node_bindings', 'profiles', 'nodes'];

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('20261024232932_link_changed_at', () => {
  it('reads its own statements: eight forward, four back', () => {
    expect(forward).toHaveLength(8);
    expect(rollback).toHaveLength(4);
  });

  it('adds the stamp to the four tables, filled with updated_at, and takes it back', async () => {
    // Against tables of their own in a scratch schema first on the search
    // path, with just the columns the statements read and write.
    const seen: Record<string, unknown> = {};
    const stamps = async (t: Tx) =>
      Object.fromEntries(
        await Promise.all(
          TABLES.map(async (table) => {
            const cols = (await t.$queryRawUnsafe<{ c: string }[]>(
              `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'a122_probe' AND table_name = '${table}'`,
            )).map((r) => r.c);
            if (!cols.includes('link_changed_at')) return [table, null];
            const rows = await t.$queryRawUnsafe<{ same: boolean }[]>(`SELECT link_changed_at = updated_at AS same FROM ${table}`);
            return [table, rows.map((r) => r.same)];
          }),
        ),
      );
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await t.$executeRawUnsafe('CREATE SCHEMA a122_probe');
        await t.$executeRawUnsafe('SET LOCAL search_path TO a122_probe');
        for (const table of TABLES) {
          await t.$executeRawUnsafe(`CREATE TABLE ${table} (id int PRIMARY KEY, updated_at timestamptz(6) NOT NULL)`);
          await t.$executeRawUnsafe(`INSERT INTO ${table} VALUES (1, '2026-01-02T03:04:05Z'), (2, '2026-05-06T07:08:09Z')`);
        }
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forward = await stamps(t);
        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.back = await stamps(t);
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.again = await stamps(t);
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    const filled = Object.fromEntries(TABLES.map((t) => [t, [true, true]]));
    expect(seen.forward).toEqual(filled);
    expect(seen.back).toEqual(Object.fromEntries(TABLES.map((t) => [t, null])));
    expect(seen.again).toEqual(filled);
    const left = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'a122_probe'`,
    );
    expect(left[0]!.n).toBe(0);
  });
});
