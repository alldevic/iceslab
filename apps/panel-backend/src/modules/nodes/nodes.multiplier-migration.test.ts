import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-143: the migration that moved the consumption multiplier to whole tenths,
 * run as its file says, forward and back.
 *
 * Old values 1, 3 and 100 (the old column's whole "times") must arrive as 10,
 * 30 and 1000; the rollback written in the file's header must bring them back
 * as 1, 3 and 100; the forward run must work again after it. Everything runs
 * in one transaction that is rolled back at the end: Postgres DDL is
 * transactional, so the shared test database is left as it was, whatever
 * fails in between.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261022234055_node_consumption_multiplier_tenths/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

function split(text: string): string[] {
  return text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The forward statements: the file without its comment lines. */
const forward = split(
  sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n'),
);

/** The rollback as the header writes it, less the bookkeeping row. */
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

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('20261022234055_node_consumption_multiplier_tenths', () => {
  it('reads its own statements: five forward, five back', () => {
    expect(forward).toHaveLength(5);
    expect(rollback).toHaveLength(5);
    expect(rollback[0]).toContain('DROP CONSTRAINT');
  });

  it('1, 3 and 100 go to 10, 30 and 1000, the header rollback brings them back, and forward runs again', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await app.inject({
        method: 'POST', url: '/api/nodes', headers: { authorization: `Bearer ${token}` },
        payload: { name: `mm-${n}`, address: `mm-${n}.test`, protocol: 'xray' },
      });
      expect(res.statusCode, res.body).toBe(201);
      ids.push(JSON.parse(res.body).id as string);
    }

    const read = async (tx: typeof prisma, column: string) => {
      const rows = await tx.$queryRawUnsafe<{ id: string; v: number | bigint }[]>(
        `SELECT id::text AS id, "${column}" AS v FROM "nodes" WHERE id = ANY($1::uuid[])`,
        ids,
      );
      const by = new Map(rows.map((r) => [r.id, Number(r.v)]));
      return ids.map((id) => by.get(id));
    };

    let seen: Record<string, (number | undefined)[]> = {};
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as typeof prisma;
        // Back to the old column, then the old values.
        for (const s of rollback) await t.$executeRawUnsafe(s);
        for (const [i, v] of [1, 3, 100].entries()) {
          await t.$executeRawUnsafe(`UPDATE "nodes" SET "consumption_multiplier" = $1 WHERE id = $2::uuid`, v, ids[i]);
        }
        seen.old = await read(t, 'consumption_multiplier');

        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forward = await read(t, 'consumption_multiplier_tenths');

        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.back = await read(t, 'consumption_multiplier');

        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.again = await read(t, 'consumption_multiplier_tenths');
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen).toEqual({
      old: [1, 3, 100],
      forward: [10, 30, 1000],
      back: [1, 3, 100],
      again: [10, 30, 1000],
    });
    // Left as it was: the tenths column, the API's 1.0 for a new node.
    const after = await prisma.node.findMany({ where: { id: { in: ids } }, select: { consumptionMultiplierTenths: true } });
    expect(after.map((n) => n.consumptionMultiplierTenths)).toEqual([10, 10, 10]);
  });

  async function threeNodes(): Promise<string[]> {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await app.inject({
        method: 'POST', url: '/api/nodes', headers: { authorization: `Bearer ${token}` },
        payload: { name: `mx-${n}`, address: `mx-${n}.test`, protocol: 'xray' },
      });
      expect(res.statusCode, res.body).toBe(201);
      ids.push(JSON.parse(res.body).id as string);
    }
    return ids;
  }

  it('a row above 100 stops the forward run on the range check, it is not clamped', async () => {
    const ids = await threeNodes();
    let reached = false;
    const run = prisma.$transaction(async (tx) => {
      const t = tx as unknown as typeof prisma;
      for (const s of rollback) await t.$executeRawUnsafe(s);
      await t.$executeRawUnsafe(`UPDATE "nodes" SET "consumption_multiplier" = 101 WHERE id = $1::uuid`, ids[0]);
      for (const s of forward) await t.$executeRawUnsafe(s);
      reached = true;
      throw new Rollback();
    }, { timeout: 30_000 });
    await expect(run).rejects.toThrow(/nodes_consumption_multiplier_tenths_range/);
    expect(reached, 'the forward run went through with 101').toBe(false);
    const after = await prisma.node.findMany({ where: { id: { in: ids } }, select: { consumptionMultiplierTenths: true } });
    expect(after.map((n) => n.consumptionMultiplierTenths)).toEqual([10, 10, 10]);
  });

  it('the rollback loses the tenths as its header says: 0 and 0.5 become 1, 1.5 rounds to 2', async () => {
    const ids = await threeNodes();
    let back: (number | undefined)[] = [];
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as typeof prisma;
        for (const [i, v] of [0, 5, 15].entries()) {
          await t.$executeRawUnsafe(`UPDATE "nodes" SET "consumption_multiplier_tenths" = $1 WHERE id = $2::uuid`, v, ids[i]);
        }
        for (const s of rollback) await t.$executeRawUnsafe(s);
        const rows = await t.$queryRawUnsafe<{ id: string; v: number | bigint }[]>(
          `SELECT id::text AS id, "consumption_multiplier" AS v FROM "nodes" WHERE id = ANY($1::uuid[])`,
          ids,
        );
        const by = new Map(rows.map((r) => [r.id, Number(r.v)]));
        back = ids.map((id) => by.get(id));
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(back).toEqual([1, 1, 2]);
    const after = await prisma.node.findMany({ where: { id: { in: ids } }, select: { consumptionMultiplierTenths: true } });
    expect(after.map((n) => n.consumptionMultiplierTenths)).toEqual([10, 10, 10]);
  });
});
