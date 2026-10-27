import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';

/**
 * The migration that adds wg_devices, run as its file says: forward, the
 * header's rollback, forward again, in one transaction rolled back at the end,
 * so the shared test database is left as it was whatever fails in between.
 */
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261028100000_wg_devices/migration.sql',
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

type Tx = typeof prisma;

const hasTable = async (t: Tx) =>
  (await t.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'wg_devices'`))[0]!.n === 1;

describe('20261028100000_wg_devices', () => {
  it('reads its own rollback', () => {
    expect(rollback.length).toBeGreaterThanOrEqual(8);
    expect(rollback.at(-2)).toBe('DROP TABLE "wg_devices"');
  });

  it("goes back keeping each user's device 1, and forward again giving every user one with their own key", async () => {
    const seen: Record<string, unknown> = {};
    await expect(
      prisma.$transaction(
        async (tx) => {
          const t = tx as unknown as Tx;
          const [{ id: userId }] = await t.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO users (id, short_id, username, subscription_token, hysteria_password,
               amneziawg_private_key, amneziawg_public_key, naive_password, xray_uuid, updated_at)
             VALUES (gen_random_uuid(), 'mig-wg', 'mig_wg', 'mig-wg-token', 'h', 'user-priv', 'user-pub', 'n',
               gen_random_uuid(), now()) RETURNING id::text`,
          );
          const [{ id: profileId }] = await t.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO profiles (id, name, protocol, config, updated_at)
             VALUES (gen_random_uuid(), 'mig-wg-awg', 'amneziawg', '{}', now()) RETURNING id::text`,
          );
          // Two devices with an address each, device 1 the older.
          const dev = async (pub: string, ip: string, at: string) => {
            const [{ id }] = await t.$queryRawUnsafe<{ id: string }[]>(
              `INSERT INTO wg_devices (id, user_id, private_key, public_key, created_at)
               VALUES (gen_random_uuid(), '${userId}', 'priv-${pub}', '${pub}', '${at}') RETURNING id::text`,
            );
            await t.$executeRawUnsafe(
              `INSERT INTO amneziawg_peers (id, profile_id, user_id, device_id, ip)
               VALUES (gen_random_uuid(), '${profileId}', '${userId}', '${id}', '${ip}')`,
            );
          };
          await dev('dev-1', '10.66.66.2', '2026-01-01T00:00:00Z');
          await dev('dev-2', '10.66.66.3', '2026-02-01T00:00:00Z');

          for (const s of rollback) await t.$executeRawUnsafe(s);
          seen.backTable = await hasTable(t);
          seen.backPeers = await t.$queryRawUnsafe(`SELECT ip FROM amneziawg_peers WHERE user_id = '${userId}' ORDER BY ip`);

          for (const s of forward) await t.$executeRawUnsafe(s);
          seen.devices = await t.$queryRawUnsafe(
            `SELECT private_key, public_key, revoked_at FROM wg_devices WHERE user_id = '${userId}'`,
          );
          seen.peers = await t.$queryRawUnsafe(
            `SELECT p.ip, d.public_key FROM amneziawg_peers p JOIN wg_devices d ON d.id = p.device_id
              WHERE p.user_id = '${userId}'`,
          );
          seen.nullDevices = (
            await t.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM amneziawg_peers WHERE device_id IS NULL`)
          )[0]!.n;
          seen.everyUserHasOne = (
            await t.$queryRawUnsafe<{ n: number }[]>(
              `SELECT count(*)::int AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM wg_devices d WHERE d.user_id = u.id)`,
            )
          )[0]!.n;
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.backTable).toBe(false);
    // Back: device 1's address stays with the user, device 2's goes.
    expect(seen.backPeers).toEqual([{ ip: '10.66.66.2' }]);
    // Forward: the user's own key is device 1, and their address is its.
    expect(seen.devices).toEqual([{ private_key: 'user-priv', public_key: 'user-pub', revoked_at: null }]);
    expect(seen.peers).toEqual([{ ip: '10.66.66.2', public_key: 'user-pub' }]);
    expect(seen.nullDevices).toBe(0);
    expect(seen.everyUserHasOne).toBe(0);
    expect(await hasTable(prisma)).toBe(true);
  });
});
