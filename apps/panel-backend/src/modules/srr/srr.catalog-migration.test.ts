import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_RULES } from '@iceslab/shared';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';

/**
 * The seed migrations against the client catalog.
 *
 * The User-Agent rules live in the database, where operators edit them, so the
 * catalog reaches them only through migrations. Two things are held here:
 *   1. an untouched table, after every seed migration, IS the catalog's
 *      CLIENT_RULES, name for name. A catalog change without a migration fails
 *      this;
 *   2. the latest migration rewrites only rows still as a seed wrote them:
 *      an operator's edits and an operator's own rules come through intact.
 *
 * The migrations run here as SQL against the test database, the statements
 * read straight out of their files, so the file is what is tested.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../prisma/migrations');
const SEEDS = ['20260505152655_add_subscription_response_rules', '20260617020000_seed_more_subscription_rules'];
const CATALOG = '20260923131631_client_catalog_rules';

/** The file's statements without its comment lines. */
function statements(dir: string, only?: RegExp): string[] {
  const sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && (!only || only.test(s)));
}

async function run(stmts: string[]) {
  for (const s of stmts) await prisma.$executeRawUnsafe(s);
}

/** The old seeds: only their INSERTs, the table itself exists already. */
const seed = () => run(SEEDS.flatMap((d) => statements(d, /^INSERT INTO/)));
// The catalog migration, then A-236's move to the core families (its data
// statement only: the column it adds is already in the test database).
const FAMILIES = '20261024183834_srr_core_families';
// 12.4: the wg flavour (its column exists already: only the data statements).
const WG_FLAVOUR = '20261126140000_srr_wg_flavour';
// 13.4: the v2rayNG rule split off the v2rayN one (data only, no column).
const V2RAYNG = '20261126150000_srr_v2rayng_plain';
const migrate = async () => {
  await run(statements(CATALOG));
  await run(statements(FAMILIES, /^UPDATE/));
  await run(statements(WG_FLAVOUR, /^(UPDATE|INSERT)/));
  await run(statements(V2RAYNG, /^INSERT/));
};

async function rules() {
  return prisma.subscriptionResponseRule.findMany({
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    select: { name: true, uaPattern: true, format: true, priority: true, proto: true },
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the seed migrations and the catalog', () => {
  it('leave an untouched table equal to CLIENT_RULES', async () => {
    await seed();
    await migrate();
    const want = [...CLIENT_RULES]
      .map((r) => ({ name: r.name, uaPattern: r.pattern, format: r.format, priority: r.priority, proto: r.proto ?? null }))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    expect(await rules()).toEqual(want);
  });

  it('rewrite only what a seed wrote, and keep every operator edit', async () => {
    await seed();
    // An operator reordered Clash (same pattern, new priority), edited Surge's
    // pattern, turned Loon's format elsewhere, and added a rule of their own.
    await prisma.subscriptionResponseRule.update({ where: { name: 'Clash' }, data: { priority: 35 } });
    await prisma.subscriptionResponseRule.update({
      where: { name: 'Surge' },
      data: { uaPattern: '(?i)surge|my-surge' },
    });
    await prisma.subscriptionResponseRule.update({ where: { name: 'Loon' }, data: { format: 'plain' } });
    await prisma.subscriptionResponseRule.create({
      data: { name: 'MyClient', uaPattern: '(?i)myclient', format: 'singbox', priority: 95 },
    });

    await migrate();
    const byName = Object.fromEntries((await rules()).map((r) => [r.name, r]));

    // Still as seeded in pattern and format: rewritten, the operator's order kept.
    expect(byName.Clash).toMatchObject({ uaPattern: '(?i)clash|mihomo', priority: 35 });
    // ...and then moved to their core families (A-236 step 4).
    expect(byName.Clash).toMatchObject({ format: 'mihomo' });
    expect(byName['NekoBox/NekoRay']).toMatchObject({ format: 'mihomo' });
    expect(byName.Stash).toMatchObject({ uaPattern: '(?i)stash', format: 'stash' });
    // Edited by the operator: left as the operator left it.
    expect(byName.Surge).toMatchObject({ uaPattern: '(?i)surge|my-surge' });
    expect(byName.Loon).toMatchObject({ uaPattern: '(?i)loon', format: 'plain' });
    expect(byName.MyClient).toMatchObject({ uaPattern: '(?i)myclient', format: 'singbox', priority: 95 });
  });

  it('rewrites Loon to catch Decar when nobody touched it', async () => {
    await seed();
    await migrate();
    const loon = await prisma.subscriptionResponseRule.findUnique({ where: { name: 'Loon' } });
    expect(loon).toMatchObject({ uaPattern: '(?i)loon|decar', format: 'loon' });
  });

  it("leaves an operator's own rule named Stash alone", async () => {
    await seed();
    await prisma.subscriptionResponseRule.create({
      data: { name: 'Stash', uaPattern: 'MyStash', format: 'surge', priority: 5 },
    });
    await migrate();
    const stash = await prisma.subscriptionResponseRule.findUnique({ where: { name: 'Stash' } });
    expect(stash).toMatchObject({ uaPattern: 'MyStash', format: 'surge', priority: 5 });
  });

  it('splits the wg rule and adds WireGuard when AmneziaWG-app is as seeded', async () => {
    await seed();
    await migrate();
    const byName = Object.fromEntries((await rules()).map((r) => [r.name, r]));
    expect(byName['AmneziaWG-app']).toMatchObject({ uaPattern: '(?i)amneziavpn|amneziawg', proto: 'amneziawg', priority: 60 });
    expect(byName.WireGuard).toMatchObject({ format: 'wgconf', proto: 'wireguard', priority: 65 });
  });

  it('leaves an edited AmneziaWG-app alone and adds no WireGuard rule beside it', async () => {
    await seed();
    await prisma.subscriptionResponseRule.update({
      where: { name: 'AmneziaWG-app' },
      data: { uaPattern: '(?i)amneziavpn|amneziawg|wireguard|mywg' },
    });
    await migrate();
    const byName = Object.fromEntries((await rules()).map((r) => [r.name, r]));
    expect(byName['AmneziaWG-app']).toMatchObject({ uaPattern: '(?i)amneziavpn|amneziawg|wireguard|mywg', proto: null });
    expect(byName.WireGuard).toBeUndefined();
  });

  it('splits v2rayNG off v2rayN when the v2rayN rule is as seeded', async () => {
    await seed();
    await migrate();
    const byName = Object.fromEntries((await rules()).map((r) => [r.name, r]));
    expect(byName.v2rayNG).toMatchObject({ uaPattern: 'v2rayNG', format: 'plain', priority: 49 });
    expect(byName.v2rayN).toMatchObject({ uaPattern: 'v2rayN|v2rayNG', format: 'xrayjson', priority: 50 });
  });

  it('leaves an edited v2rayN rule alone and adds no v2rayNG rule beside it', async () => {
    await seed();
    await prisma.subscriptionResponseRule.update({ where: { name: 'v2rayN' }, data: { format: 'plain' } });
    await migrate();
    const byName = Object.fromEntries((await rules()).map((r) => [r.name, r]));
    expect(byName.v2rayN).toMatchObject({ uaPattern: 'v2rayN|v2rayNG', format: 'plain', priority: 50 });
    expect(byName.v2rayNG).toBeUndefined();
  });

  it('can run twice', async () => {
    await seed();
    await migrate();
    const once = await rules();
    await migrate();
    expect(await rules()).toEqual(once);
  });
});
