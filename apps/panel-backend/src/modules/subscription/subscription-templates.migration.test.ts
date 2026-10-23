import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_TYPES } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';

/**
 * A-236 step 2: the migration that creates subscription_templates, run as its
 * file says, forward and back (the A-143 pattern): the statements and the
 * rollback are read out of migration.sql itself, and everything runs in one
 * transaction rolled back at the end, so the shared test database is left as
 * it was.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261023163439_subscription_templates/migration.sql',
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

async function insert(t: Tx, type: string, name: string): Promise<void> {
  await t.$executeRawUnsafe(
    `INSERT INTO "subscription_templates" ("id", "type", "name", "body", "updated_at")
     VALUES (gen_random_uuid(), $1, $2, 'x', now())`,
    type,
    name,
  );
}

/** Runs `fn` inside a savepoint and answers the error message, or null. */
async function refusal(t: Tx, fn: () => Promise<unknown>): Promise<string | null> {
  await t.$executeRawUnsafe('SAVEPOINT probe');
  try {
    await fn();
    await t.$executeRawUnsafe('RELEASE SAVEPOINT probe');
    return null;
  } catch (err) {
    await t.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
    return String((err as Error).message);
  }
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('20261023163439_subscription_templates', () => {
  it('reads its own statements: two forward, one back', () => {
    expect(forward).toHaveLength(2);
    expect(rollback).toEqual(['DROP TABLE "subscription_templates"']);
  });

  it('forward makes the table with its rules, back drops it, forward again works', async () => {
    const seen: Record<string, unknown> = {};
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as Tx;
        const exists = async () =>
          (await t.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'subscription_templates'`,
          ))[0]!.n;

        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.afterBack = await exists();
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.afterForward = await exists();

        // Every type the code knows is stored; one it does not know is refused.
        for (const type of TEMPLATE_TYPES) await insert(t, type, 'Default');
        seen.unknownType = await refusal(t, () => insert(t, 'surge', 'Default'));
        // A name is unique within its type, and only there.
        seen.sameName = await refusal(t, () => insert(t, 'mihomo', 'Default'));
        seen.otherType = await refusal(t, () => insert(t, 'stash', 'mine'));

        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.backAgain = await exists();
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forwardAgain = await exists();
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.afterBack).toBe(0);
    expect(seen.afterForward).toBe(1);
    expect(seen.unknownType).toMatch(/subscription_templates_type_known/);
    expect(seen.sameName).toMatch(/subscription_templates_type_name_key|duplicate key/);
    expect(seen.otherType).toBeNull();
    expect(seen.backAgain).toBe(0);
    expect(seen.forwardAgain).toBe(1);
    // Left as it was: the table is there and empty.
    expect(await prisma.subscriptionTemplate.count()).toBe(0);
  });
});
