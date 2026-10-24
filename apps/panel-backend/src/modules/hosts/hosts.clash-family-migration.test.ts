import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { _resetBindingsCacheForTest, registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';

/**
 * A-249: the migration that closes the whole Clash family on hosts switched
 * off for `clash`, run as its file says, forward and back (the A-143
 * pattern); one transaction rolled back at the end.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261024194248_host_clash_family_off/migration.sql',
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

// A host edit mid-test must reach the next /sub read; the bus is wired in
// index.ts, not buildApp. Subscribed once: it has no unsubscribe.
beforeAll(() => registerBindingsCacheBust());

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('20261024194248_host_clash_family_off', () => {
  it('reads its own statements: one forward, one back', () => {
    expect(forward).toHaveLength(1);
    expect(rollback).toHaveLength(1);
  });

  it('adds mihomo, stash and clash-legacy where clash is off, once, and takes them back', async () => {
    // The statements address "hosts" unqualified. They run here against a
    // "hosts" of their own in a scratch schema first on the search path, with
    // just the column they read and write: a host row needs a binding, a
    // profile and a node, none of which the statements look at. Everything
    // goes with the rolled-back transaction.
    const seen: Record<string, unknown> = {};
    const lists = async (t: Tx) =>
      Object.fromEntries(
        (await t.$queryRawUnsafe<{ name: string; l: string[] }[]>(`SELECT name, disable_for_formats AS l FROM hosts ORDER BY name`)).map(
          (r) => [r.name, r.l],
        ),
      );
    await expect(
      prisma.$transaction(async (tx) => {
        const t = tx as unknown as Tx;
        await t.$executeRawUnsafe('CREATE SCHEMA a249_probe');
        await t.$executeRawUnsafe('SET LOCAL search_path TO a249_probe');
        await t.$executeRawUnsafe('CREATE TABLE hosts (name text PRIMARY KEY, disable_for_formats text[] NOT NULL)');
        await t.$executeRawUnsafe(`INSERT INTO hosts VALUES
          ('clash-off', ARRAY['clash']),
          ('clash-and-stash-off', ARRAY['singbox', 'clash', 'stash']),
          ('plain-off', ARRAY['plain']),
          ('none-off', ARRAY[]::text[])`);
        seen.before = await lists(t);
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.forward = await lists(t);
        for (const s of rollback) await t.$executeRawUnsafe(s);
        seen.back = await lists(t);
        for (const s of forward) await t.$executeRawUnsafe(s);
        seen.again = await lists(t);
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);

    const before = {
      'clash-and-stash-off': ['singbox', 'clash', 'stash'],
      'clash-off': ['clash'],
      'none-off': [],
      'plain-off': ['plain'],
    };
    const after = {
      'clash-and-stash-off': ['singbox', 'clash', 'stash', 'mihomo', 'clash-legacy'],
      'clash-off': ['clash', 'mihomo', 'stash', 'clash-legacy'],
      'none-off': [],
      'plain-off': ['plain'],
    };
    expect(seen.before).toEqual(before);
    expect(seen.forward).toEqual(after);
    // Back takes all three names off a host with clash, the one stash it had
    // before included (said in the migration's header).
    expect(seen.back).toEqual({ ...before, 'clash-and-stash-off': ['singbox', 'clash'] });
    // Forward again appends in its own order, so the stash back took comes
    // after mihomo now; the set is what the first forward left.
    expect(seen.again).toEqual({ ...after, 'clash-and-stash-off': ['singbox', 'clash', 'mihomo', 'stash', 'clash-legacy'] });
    // The scratch schema went with the transaction.
    const left = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'a249_probe'`,
    );
    expect(left[0]!.n).toBe(0);
  });
});

// ------------------------------------------------------------ through the API

describe('a host off for the Clash family, as the panel and the client see it', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    invalidateSrrCache();
    token = await registerAndLogin(app);
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  /** One node, one vless binding with its auto-created host, one user. */
  async function subscriber(): Promise<{ sub: string; hostId: string }> {
    const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth(), payload: { name: 'cf-node', address: 'cf.test', protocol: 'xray' } });
    const profile = await app.inject({
      method: 'POST', url: '/api/profiles', headers: auth(),
      payload: {
        name: 'cf-profile', protocol: 'xray',
        config: {
          security: 'reality', subprotocol: 'vless', network: 'raw',
          realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
          realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
        },
      },
    });
    const binding = await app.inject({
      method: 'POST', url: '/api/bindings', headers: auth(),
      payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
    });
    expect(binding.statusCode, binding.body).toBe(201);
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'cf-user' } });
    const sub = (await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true } }))
      .subscriptionToken;
    const host = await prisma.host.findFirstOrThrow({ select: { id: true } });
    // The truncate takes the seeded rules too: back as 20261024183834 leaves
    // them, Clash to mihomo, Stash to its own.
    for (const [name, uaPattern, format] of [['Clash', '(?i)clash|mihomo', 'mihomo'], ['Stash', '(?i)stash', 'stash']] as const) {
      const rule = await app.inject({ method: 'POST', url: '/api/srr', headers: auth(), payload: { name, uaPattern, format, priority: 1 } });
      expect(rule.statusCode, rule.body).toBe(201);
    }
    return { sub, hostId: host.id };
  }

  const setOff = (hostId: string, formats: string[]) =>
    app.inject({ method: 'PUT', url: `/api/hosts/${hostId}`, headers: auth(), payload: { disableForFormats: formats } });

  /** Whether the host's address is in what the client is answered. */
  async function serves(sub: string, query: string, ua?: string): Promise<boolean> {
    const res = await app.inject({ method: 'GET', url: `/sub/${sub}${query}`, headers: ua ? { 'user-agent': ua } : {} });
    expect(res.statusCode, res.body).toBe(200);
    return res.body.includes('cf.test');
  }

  it('after the migration the host screen reads all four off', async () => {
    const { hostId } = await subscriber();
    await prisma.host.update({ where: { id: hostId }, data: { disableForFormats: ['clash'] } });
    for (const s of forward) await prisma.$executeRawUnsafe(s);
    const res = await app.inject({ method: 'GET', url: '/api/hosts', headers: auth() });
    expect(res.statusCode).toBe(200);
    const host = (JSON.parse(res.body) as { hosts: { id: string; disableForFormats: string[] }[] }).hosts.find((h) => h.id === hostId);
    expect(host?.disableForFormats).toEqual(['clash', 'mihomo', 'stash', 'clash-legacy']);
  });

  it('a host off for clash goes to no mihomo client by its UA and to no Stash client', async () => {
    const { sub, hostId } = await subscriber();
    expect(await serves(sub, '', 'clash-verge/v2.0.0')).toBe(true);
    expect(await serves(sub, '', 'Stash/2.5.0')).toBe(true);
    expect((await setOff(hostId, ['clash'])).statusCode).toBe(200);
    expect(await serves(sub, '', 'clash-verge/v2.0.0')).toBe(false);
    expect(await serves(sub, '?format=mihomo')).toBe(false);
    // Stash is closed by the migration's names, not by the alias rule.
    // The migration runs before the panel starts, so nothing is cached yet;
    // here the cache of the reads above is dropped by hand.
    for (const s of forward) await prisma.$executeRawUnsafe(s);
    _resetBindingsCacheForTest();
    expect(await serves(sub, '', 'Stash/2.5.0')).toBe(false);
  });

  it('a host off for mihomo does not go to ?format=clash; one off for neither goes everywhere', async () => {
    const { sub, hostId } = await subscriber();
    expect((await setOff(hostId, ['mihomo'])).statusCode).toBe(200);
    expect(await serves(sub, '?format=clash')).toBe(false);
    expect(await serves(sub, '?format=mihomo')).toBe(false);
    expect((await setOff(hostId, ['plain'])).statusCode).toBe(200);
    for (const q of ['?format=clash', '?format=mihomo', '?format=stash', '?format=singbox']) {
      expect(await serves(sub, q), q).toBe(true);
    }
    expect(await serves(sub, '', 'clash-verge/v2.0.0')).toBe(true);
    expect(await serves(sub, '', 'Stash/2.5.0')).toBe(true);
  });
});
