import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * A-236 step 6: the migration that gives a host its description and its
 * hidden flag, run as its file says, forward and back (the A-143 pattern); one
 * transaction rolled back at the end.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261024204203_host_description_hidden/migration.sql',
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

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('20261024204203_host_description_hidden', () => {
  it('reads its own statements: one forward, one back', () => {
    expect(forward).toHaveLength(1);
    expect(rollback).toHaveLength(1);
  });

  it('adds the two columns, an existing host visible and without a description, and takes them back', async () => {
    // Against a "hosts" of its own in a scratch schema first on the search
    // path: a real host row needs a binding, a profile and a node, and the
    // statements look at none of them. Everything goes with the transaction.
    const seen: Record<string, unknown> = {};
    const columns = async (t: Tx) =>
      (
        await t.$queryRawUnsafe<{ c: string }[]>(
          `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'a236s6_probe' AND table_name = 'hosts' ORDER BY column_name`,
        )
      ).map((r) => r.c);
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await t.$executeRawUnsafe('CREATE SCHEMA a236s6_probe');
        await t.$executeRawUnsafe('SET LOCAL search_path TO a236s6_probe');
        await t.$executeRawUnsafe('CREATE TABLE hosts (name text PRIMARY KEY)');
        await t.$executeRawUnsafe(`INSERT INTO hosts VALUES ('before')`);
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forward = await columns(t);
        seen.row = await t.$queryRawUnsafe(`SELECT name, server_description, is_hidden FROM hosts`);
        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.back = await columns(t);
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.again = await columns(t);
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.forward).toEqual(['is_hidden', 'name', 'server_description']);
    expect(seen.row).toEqual([{ name: 'before', server_description: null, is_hidden: false }]);
    expect(seen.back).toEqual(['name']);
    expect(seen.again).toEqual(seen.forward);
    const left = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'a236s6_probe'`,
    );
    expect(left[0]!.n).toBe(0);
  });
});
