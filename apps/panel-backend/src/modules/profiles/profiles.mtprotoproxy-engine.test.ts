import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { engineValidForProtocol } from './profiles.schemas.js';

/**
 * MTProto's engine: mtprotoproxy is the one value the API takes for it, and
 * mtg is the absence of an engine (one record per state). The engine a profile
 * was saved with is the one it is read back with, and a save does not drop it.
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
const CONFIG = { domain: 'www.example.com' };

async function createProfile(name: string, engine?: string | null) {
  return app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name, protocol: 'mtproto', ...(engine === undefined ? {} : { engine }), config: CONFIG },
  });
}

describe('profile schema: engine of an mtproto profile', () => {
  it('takes mtprotoproxy', async () => {
    const res = await createProfile('mt-pp', 'mtprotoproxy');
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).engine).toBe('mtprotoproxy');
  });

  it('refuses sing-box', async () => {
    const res = await createProfile('mt-sb', 'singbox');
    expect(res.statusCode, res.body).toBe(400);
  });

  it('without an engine is as before: mtg, engine null', async () => {
    const res = await createProfile('mt-mtg');
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).engine ?? null).toBeNull();
  });

  it('refuses mtprotoproxy on another protocol', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: { name: 'hy-pp', protocol: 'hysteria', engine: 'mtprotoproxy', config: {} },
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('a save of the form as it was loaded keeps the engine', async () => {
    const created = JSON.parse((await createProfile('mt-keep', 'mtprotoproxy')).body) as { id: string };
    const put = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${created.id}`,
      headers: auth(),
      payload: { name: 'mt-keep', engine: 'mtprotoproxy', config: CONFIG },
    });
    expect(put.statusCode, put.body).toBe(200);
    const read = await app.inject({ method: 'GET', url: `/api/profiles/${created.id}`, headers: auth() });
    expect(JSON.parse(read.body).engine).toBe('mtprotoproxy');
  });

  it('engineValidForProtocol: mtproto takes mtprotoproxy and nothing else', () => {
    expect(engineValidForProtocol('mtproto', 'mtprotoproxy')).toBe(true);
    expect(engineValidForProtocol('mtproto', null)).toBe(true);
    expect(engineValidForProtocol('mtproto', 'singbox')).toBe(false);
    expect(engineValidForProtocol('mtproto', 'mtproto')).toBe(false);
  });
});
