import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-257: a save that meets a unique index says WHICH one, on the database's
 * own error (meta.target is empty through the pg adapter, so nothing here is
 * a hand-made meta). Where a check runs before the write, it is blinded for
 * the one call, so the write reaches the index every time instead of only
 * when a race lands.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const send = async (method: 'POST' | 'PUT', url: string, payload: object) => {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as { error?: string; field?: string; message?: string; id?: string } };
};

describe('regions: name and code', () => {
  it('names the field that is taken, on create and on edit', async () => {
    expect((await send('POST', '/api/regions', { name: 'Europe', code: 'eu' })).status).toBe(201);
    const byName = await send('POST', '/api/regions', { name: 'Europe', code: 'eu2' });
    expect(byName.status).toBe(409);
    expect(byName.body).toMatchObject({ error: 'CONFLICT', field: 'name' });
    const byCode = await send('POST', '/api/regions', { name: 'Europe 2', code: 'eu' });
    expect(byCode.status).toBe(409);
    expect(byCode.body).toMatchObject({ error: 'CONFLICT', field: 'code' });
    expect(byCode.body.message).toContain('"eu"');

    const other = await send('POST', '/api/regions', { name: 'Asia', code: 'as' });
    const edit = await send('PUT', `/api/regions/${other.body.id}`, { code: 'eu' });
    expect(edit.status).toBe(409);
    expect(edit.body.field).toBe('code');
  });
});

describe('route policies: name and band', () => {
  const policy = (name: string, ordinal?: number) => ({ name, blockDomains: ['ads.example.com'], ...(ordinal ? { ordinal } : {}) });

  it('names the band when the band was taken under the check', async () => {
    expect((await send('POST', '/api/route-policies', policy('no-ads', 3))).status).toBe(201);
    // The check before the insert finds nothing, as when two saves race.
    vi.spyOn(prisma.routePolicy, 'findFirst').mockResolvedValueOnce(null);
    const res = await send('POST', '/api/route-policies', policy('other', 3));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'CONFLICT', field: 'ordinal' });
  });

  it('names the name when the name was taken under the check, and on an edit', async () => {
    expect((await send('POST', '/api/route-policies', policy('no-ads'))).status).toBe(201);
    vi.spyOn(prisma.routePolicy, 'findFirst').mockResolvedValueOnce(null);
    const res = await send('POST', '/api/route-policies', policy('no-ads'));
    expect(res.status).toBe(409);
    expect(res.body.field).toBe('name');

    const second = await send('POST', '/api/route-policies', policy('second'));
    const edit = await send('PUT', `/api/route-policies/${second.body.id}`, { name: 'no-ads' });
    expect(edit.status).toBe(409);
    expect(edit.body.field).toBe('name');
  });
});

describe('named outbounds: name', () => {
  it('refuses a name taken under the check with the same 409, not a 500', async () => {
    const ok = await send('POST', '/api/named-outbounds', { name: 'georgia', type: 'freedom' });
    expect(ok.status).toBe(201);
    vi.spyOn(prisma.namedOutbound, 'findUnique').mockResolvedValueOnce(null);
    const res = await send('POST', '/api/named-outbounds', { name: 'georgia', type: 'blackhole' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('georgia');
    expect(await prisma.namedOutbound.count()).toBe(1);
  });
});
