import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { ensureDevices, revokeDevice } from '../wg-devices/wg-devices.service.js';
import { awgCredentialsOf } from './awg-addresses.js';

/**
 * A user on an AmneziaWG node is a peer per device: each its own key, its own
 * address on every generation the user reaches, and its preshared key where
 * that generation's profile asks for one. Device 1 also rides in the single
 * fields an agent older than devices reads.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

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

const post = async (url: string, payload: object) => {
  const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as Record<string, unknown>;
};

/** A node with a 1.x and a 3.1 AmneziaWG binding; the 3.1 profile asks for
 *  preshared keys, the 1.x one does not. */
async function awgNode(): Promise<{ one: string; three: string }> {
  seq += 1;
  const node = await post('/api/nodes', { name: `awg-${seq}`, address: `awg-${seq}.test` });
  const profile = (gen: 1 | 3) =>
    post('/api/profiles', {
      name: `awg-${seq}-${gen}`,
      protocol: 'amneziawg',
      ...(gen === 3 ? { awgProtocol: 3 } : {}),
      config: {
        serverPrivateKey: 'a'.repeat(43) + '=',
        serverPublicKey: 'b'.repeat(43) + '=',
        subnet: gen === 3 ? '10.67.67.0/24' : '10.66.66.0/24',
        obfuscation: {},
        ...(gen === 3 ? { presharedKey: true } : {}),
      },
    });
  const [p1, p3] = await Promise.all([profile(1), profile(3)]);
  const bind = (profileId: unknown, port: number) =>
    prisma.profileNodeBinding.create({
      data: { profileId: profileId as string, nodeId: node.id as string, port, transport: 'udp', enabled: true },
    });
  const [b1, b3] = await Promise.all([bind(p1.id, 51820), bind(p3.id, 51830)]);
  return { one: b1.id, three: b3.id };
}

const user = async (name: string) => (await post('/api/users', { username: name })).id as string;

describe('awgCredentialsOf', () => {
  it('a peer per live device, with an address on each generation the user reaches', async () => {
    const bindings = await awgNode();
    const u = await user('alice');
    const [d1, d2, d3] = await ensureDevices(u, 3);
    await revokeDevice(d2!.id);

    const creds = (await awgCredentialsOf(bindings, [{ id: u, username: 'alice', reachesOne: true, reachesThree: true }])).get(u)!;
    expect(creds.amneziawgPeers.map((p) => p.publicKey)).toEqual([d1!.publicKey, d3!.publicKey]);
    for (const p of creds.amneziawgPeers) {
      expect(p.allowedIp).toMatch(/^10\.66\.66\.\d+$/);
      expect(p.allowedIp3).toMatch(/^10\.67\.67\.\d+$/);
      // The preshared key goes with the 3.1 address alone: only that profile asks.
      expect(p.presharedKey).toBeUndefined();
    }
    expect(creds.amneziawgPeers[0]!.presharedKey3).toBe(d1!.presharedKey);
    expect(new Set(creds.amneziawgPeers.map((p) => p.allowedIp)).size).toBe(2);
    // Device 1 for the agents that read the single fields.
    expect(creds.amneziawgPublicKey).toBe(d1!.publicKey);
    expect(creds.amneziawgAllowedIp).toBe(creds.amneziawgPeers[0]!.allowedIp);
    expect(creds.amneziawgAllowedIp3).toBe(creds.amneziawgPeers[0]!.allowedIp3);
  });

  it('the same addresses the second time, and only the generation reached', async () => {
    const bindings = await awgNode();
    const u = await user('alice');
    await ensureDevices(u, 2);
    const ask = (three: boolean) =>
      awgCredentialsOf(bindings, [{ id: u, username: 'alice', reachesOne: true, reachesThree: three }]);
    const a = (await ask(false)).get(u)!;
    const b = (await ask(false)).get(u)!;
    expect(b.amneziawgPeers).toEqual(a.amneziawgPeers);
    expect(a.amneziawgPeers.every((p) => p.allowedIp && !p.allowedIp3)).toBe(true);
  });

  it('a user who reaches it with no device left gets an empty list; one who does not reach it, nothing', async () => {
    const bindings = await awgNode();
    const reaching = await user('alice');
    const other = await user('bob');
    const [d] = await ensureDevices(reaching, 1);
    await revokeDevice(d!.id);

    const out = await awgCredentialsOf(bindings, [
      { id: reaching, username: 'alice', reachesOne: true, reachesThree: false },
      { id: other, username: 'bob', reachesOne: false, reachesThree: false },
    ]);
    expect(out.get(reaching)).toEqual({ amneziawgPeers: [] });
    expect(out.has(other)).toBe(false);
  });

  it('a node with no AmneziaWG binding: nobody', async () => {
    const u = await user('alice');
    await ensureDevices(u, 1);
    expect((await awgCredentialsOf({}, [{ id: u, username: 'alice', reachesOne: true, reachesThree: true }])).size).toBe(0);
  });
});
