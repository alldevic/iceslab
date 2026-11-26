import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';

/**
 * The migration that adds wg_devices (9.4), run as its file says: the header's
 * rollback first, so the database is in the shape of v0.3.1 and holds users
 * with their keys and addresses, then the migration forward. One transaction
 * rolled back at the end, so the shared test database is left as it was
 * whatever fails in between.
 */
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations/20261126090000_wg_devices/migration.sql',
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
  const start = lines.findIndex((l) => /^--\s*Rollback/i.test(l));
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('--   ')) break;
    body.push(l.slice('--   '.length));
  }
  return split(body.join('\n')).filter((s) => !s.includes('_prisma_migrations'));
})();

class Rollback extends Error {}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

type Tx = typeof prisma;

const hasTable = async (t: Tx) =>
  (await t.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'wg_devices'`))[0]!.n === 1;

describe('20261126090000_wg_devices', () => {
  it('reads its own rollback', () => {
    expect(rollback.length).toBeGreaterThanOrEqual(7);
    expect(rollback.at(-1)).toBe('DROP TABLE "wg_devices"');
  });

  it("on a database with users: device 1 of each is their old key, and their old address is its", async () => {
    const seen: Record<string, unknown> = {};
    await expect(
      prisma.$transaction(
        async (tx) => {
          const t = tx as unknown as Tx;
          for (const s of rollback) await t.$executeRawUnsafe(s);
          seen.backTable = await hasTable(t);

          const user = async (n: string, key: string, deleted = false) =>
            (
              await t.$queryRawUnsafe<{ id: string }[]>(
                `INSERT INTO users (id, short_id, username, subscription_token, hysteria_password,
                   amneziawg_private_key, amneziawg_public_key, naive_password, xray_uuid, updated_at, deleted_at)
                 VALUES (gen_random_uuid(), 'mig-${n}', 'mig_${n}', 'mig-${n}-token', 'h', 'priv-${key}', 'pub-${key}', 'n',
                   gen_random_uuid(), now(), ${deleted ? 'now()' : 'NULL'}) RETURNING id::text`,
              )
            )[0]!.id;
          const alice = await user('a', 'alice');
          const carol = await user('c', 'carol', true); // soft-deleted, still a user
          const bob = await user('b', 'bob'); // no address yet
          const [{ id: awg }, { id: wg }] = await Promise.all(
            ['amneziawg', 'wireguard'].map(async (protocol) =>
              (
                await t.$queryRawUnsafe<{ id: string }[]>(
                  `INSERT INTO profiles (id, name, protocol, config, updated_at)
                   VALUES (gen_random_uuid(), 'mig-${protocol}', '${protocol}', '{}', now()) RETURNING id::text`,
                )
              )[0]!,
            ),
          );
          const peer = (profile: string, userId: string, ip: string) =>
            t.$executeRawUnsafe(
              `INSERT INTO amneziawg_peers (id, profile_id, user_id, ip) VALUES (gen_random_uuid(), '${profile}', '${userId}', '${ip}')`,
            );
          await peer(awg, alice, '10.66.66.2');
          await peer(wg, alice, '10.77.77.2');
          await peer(awg, carol, '10.66.66.3');

          for (const s of forward) await t.$executeRawUnsafe(s);

          seen.devices = await t.$queryRawUnsafe(
            `SELECT u.username, d.private_key, d.public_key, d.revoked_at, d.preshared_key, d.bytes_in::text AS bytes_in
               FROM wg_devices d JOIN users u ON u.id = d.user_id ORDER BY u.username`,
          );
          seen.peers = await t.$queryRawUnsafe(
            `SELECT u.username, p.ip, d.public_key FROM amneziawg_peers p
               JOIN wg_devices d ON d.id = p.device_id JOIN users u ON u.id = p.user_id ORDER BY p.ip`,
          );
          seen.unbound = (
            await t.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM amneziawg_peers WHERE device_id IS NULL`)
          )[0]!.n;
          // A second device of alice on the same profile: the old (profile, user)
          // rule is gone, (profile, device) and (profile, ip) are the rules now.
          const [{ id: second }] = await t.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO wg_devices (id, user_id, private_key, public_key) VALUES (gen_random_uuid(), '${alice}', 'p2', 'pub-2') RETURNING id::text`,
          );
          await t.$executeRawUnsafe(
            `INSERT INTO amneziawg_peers (id, profile_id, user_id, device_id, ip)
             VALUES (gen_random_uuid(), '${awg}', '${alice}', '${second}', '10.66.66.9')`,
          );
          seen.aliceOnAwg = (
            await t.$queryRawUnsafe<{ n: number }[]>(
              `SELECT count(*)::int AS n FROM amneziawg_peers WHERE profile_id = '${awg}' AND user_id = '${alice}'`,
            )
          )[0]!.n;
          await t.$executeRawUnsafe('SAVEPOINT dup');
          seen.sameDevice = await t
            .$executeRawUnsafe(
              `INSERT INTO amneziawg_peers (id, profile_id, user_id, device_id, ip)
               SELECT gen_random_uuid(), '${awg}', '${alice}', '${second}', '10.66.66.10'`,
            )
            .then(() => 'allowed')
            .catch(() => 'refused');
          await t.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dup');
          seen.bob = bob;
          throw new Rollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.backTable).toBe(false);
    // Every user, the soft-deleted one included, has one device: their own key.
    expect(seen.devices).toEqual([
      { username: 'mig_a', private_key: 'priv-alice', public_key: 'pub-alice', revoked_at: null, preshared_key: null, bytes_in: '0' },
      { username: 'mig_b', private_key: 'priv-bob', public_key: 'pub-bob', revoked_at: null, preshared_key: null, bytes_in: '0' },
      { username: 'mig_c', private_key: 'priv-carol', public_key: 'pub-carol', revoked_at: null, preshared_key: null, bytes_in: '0' },
    ]);
    // Their addresses are that device's: a config handed out before keeps working.
    expect(seen.peers).toEqual([
      { username: 'mig_a', ip: '10.66.66.2', public_key: 'pub-alice' },
      { username: 'mig_c', ip: '10.66.66.3', public_key: 'pub-carol' },
      { username: 'mig_a', ip: '10.77.77.2', public_key: 'pub-alice' },
    ]);
    expect(seen.unbound).toBe(0);
    expect(seen.aliceOnAwg).toBe(2);
    expect(seen.sameDevice).toBe('refused');
  });

  it('leaves the schema as the migration history says (a second device, a unique key)', async () => {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN
         ('wg_devices_public_key_key', 'amneziawg_peers_profile_id_device_id_key', 'amneziawg_peers_device_id_idx')`,
    );
    expect(n).toBe(3);
    const [{ old }] = await prisma.$queryRawUnsafe<{ old: number }[]>(
      `SELECT count(*)::int AS old FROM pg_indexes WHERE indexname = 'amneziawg_peers_profile_id_user_id_key'`,
    );
    expect(old).toBe(0);
  });
});
