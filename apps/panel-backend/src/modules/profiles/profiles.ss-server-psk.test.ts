import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-028: an edit of a Shadowsocks profile keeps the stored server key when
 * the payload does not carry one. The form has no serverPsk field, so every
 * save from the profile screen omitted it and the key the node runs was
 * replaced: every 2022 client lost the server half of its password.
 */
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

const auth = () => ({ authorization: `Bearer ${token}` });

async function create(method: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name: `ss-${method}`, protocol: 'shadowsocks', config: { method } },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

const stored = async (id: string) =>
  (await prisma.profile.findUniqueOrThrow({ where: { id } })).config as { method: string; serverPsk: string };

const edit = (id: string, config: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/profiles/${id}`, headers: auth(), payload: { config } });

describe('the Shadowsocks server key across an edit', () => {
  it('survives an edit that does not mention it', async () => {
    const id = await create('2022-blake3-aes-256-gcm');
    const before = await stored(id);
    expect(Buffer.from(before.serverPsk, 'base64')).toHaveLength(32);

    const res = await edit(id, { method: '2022-blake3-aes-256-gcm' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored(id)).serverPsk).toBe(before.serverPsk);
  });

  it('a key the payload does carry still replaces it', async () => {
    const id = await create('2022-blake3-aes-256-gcm');
    const mine = Buffer.alloc(32, 7).toString('base64');
    expect((await edit(id, { method: '2022-blake3-aes-256-gcm', serverPsk: mine })).statusCode).toBe(200);
    expect((await stored(id)).serverPsk).toBe(mine);
  });

  it('a method of another key length gets a new key of that length, not the old one', async () => {
    const id = await create('2022-blake3-aes-256-gcm');
    const before = await stored(id);
    expect((await edit(id, { method: '2022-blake3-aes-128-gcm' })).statusCode).toBe(200);
    const after = await stored(id);
    expect(after.serverPsk).not.toBe(before.serverPsk);
    expect(Buffer.from(after.serverPsk, 'base64')).toHaveLength(16);
  });
});
