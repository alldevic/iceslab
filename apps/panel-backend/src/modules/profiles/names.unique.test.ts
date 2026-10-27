import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { geoSetsQueue } from '../geo-sets/geo-sets.queue.js';

/**
 * A-257: squads, profiles and geo sets check a name is free, then insert. Two
 * creates of one name at once both pass the check and the loser met the
 * unique index as a 500. Now it is the same 409 the check gives.
 */

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  // Nothing reaches the real queue: the dev backend's worker shares this Redis.
  vi.spyOn(geoSetsQueue, 'add').mockResolvedValue({} as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await geoSetsQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

async function race(url: string, payload: Record<string, unknown>) {
  return Promise.all(
    [0, 1, 2, 3].map(() => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload })),
  );
}

describe('a create racing on one name', () => {
  it('squads: one 201, the rest 409 NAME_TAKEN, no 500', async () => {
    const res = await race('/api/squads', { name: 'same-squad', profileIds: [] });
    expect(res.map((r) => r.statusCode).sort(), res.map((r) => r.body).join('\n')).toEqual([201, 409, 409, 409]);
    for (const r of res.filter((x) => x.statusCode === 409)) expect(JSON.parse(r.body).error).toBe('NAME_TAKEN');
  });

  it('profiles: one 201, the rest 409, no 500', async () => {
    const res = await race('/api/profiles', {
      name: 'same-profile', protocol: 'shadowsocks', config: { method: '2022-blake3-aes-128-gcm' },
    });
    expect(res.map((r) => r.statusCode).sort(), res.map((r) => r.body).join('\n')).toEqual([201, 409, 409, 409]);
    for (const r of res.filter((x) => x.statusCode === 409)) expect(JSON.parse(r.body).message).toContain('same-profile');
  });

  it('geo sets: one 202 (checking), the rest 409 GEO_SET_NAME_TAKEN, no 500', async () => {
    const res = await race('/api/geo-sets', {
      name: 'samelist', kind: 'geosite', source: { type: 'url', url: 'https://example.com/x.dat', sha256Source: 'sidecar' },
    });
    expect(res.map((r) => r.statusCode).sort(), res.map((r) => r.body).join('\n')).toEqual([202, 409, 409, 409]);
    for (const r of res.filter((x) => x.statusCode === 409)) expect(JSON.parse(r.body).error).toBe('GEO_SET_NAME_TAKEN');
  });
});
