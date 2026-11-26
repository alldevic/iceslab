import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { HardeningSchema } from './nodes.schemas.js';
import { appendHardeningFlags, hardeningFlags } from './nodes.service.js';

/**
 * The cold-pool labels live in the node's `hardening` blob, and the node page
 * does not send them. A save that does not name `pool` must keep them: a burned
 * IP whose mark is lost is a burned IP the pool promotes again.
 */
describe('hardening.pool on PUT /api/nodes/:id', () => {
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
  const put = (id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload });
  const stored = async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id } })).hardening;

  async function nodeWithLabels(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'pl1', address: 'pl1.test' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (JSON.parse(res.body) as { id: string }).id;
    const set = await put(id, { hardening: { fail2ban: true, pool: { spare: true, asn: 'AS1', provider: 'ovh', burned: true } } });
    expect(set.statusCode, set.body).toBe(200);
    return id;
  }

  const LABELS = { spare: true, asn: 'AS1', provider: 'ovh', burned: true };

  it('the labels are set and shown through the API', async () => {
    const id = await nodeWithLabels();
    expect(await stored(id)).toEqual({ fail2ban: true, pool: LABELS });
    const got = await app.inject({ method: 'GET', url: `/api/nodes/${id}`, headers: auth() });
    expect(JSON.parse(got.body).hardening).toEqual({ fail2ban: true, pool: LABELS });
  });

  it('a hardening that does not name pool keeps the labels', async () => {
    const id = await nodeWithLabels();
    const res = await put(id, { hardening: { ufwLockdown: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(id)).toEqual({ ufwLockdown: true, pool: LABELS });
  });

  it('an empty hardening and a null one keep them too', async () => {
    const id = await nodeWithLabels();
    expect((await put(id, { hardening: {} })).statusCode).toBe(200);
    expect(await stored(id)).toEqual({ pool: LABELS });
    expect((await put(id, { hardening: null })).statusCode).toBe(200);
    expect(await stored(id)).toEqual({ pool: LABELS });
  });

  it('a body without hardening touches nothing', async () => {
    const id = await nodeWithLabels();
    expect((await put(id, { name: 'pl1b' })).statusCode).toBe(200);
    expect(await stored(id)).toEqual({ fail2ban: true, pool: LABELS });
  });

  it('a hardening that names pool replaces the labels', async () => {
    const id = await nodeWithLabels();
    const res = await put(id, { hardening: { pool: { asn: 'AS2' } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(id)).toEqual({ pool: { asn: 'AS2' } });
  });

  it('a node that never had labels is saved as before, null stays null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'pl2', address: 'pl2.test' },
    });
    const id = (JSON.parse(res.body) as { id: string }).id;
    expect((await put(id, { hardening: { fail2ban: true } })).statusCode).toBe(200);
    expect(await stored(id)).toEqual({ fail2ban: true });
    expect((await put(id, { hardening: null })).statusCode).toBe(200);
    expect(await stored(id)).toBeNull();
  });

  it('an unknown key inside pool is a 400', async () => {
    const id = await nodeWithLabels();
    const res = await put(id, { hardening: { pool: { asn: 'AS2', colour: 'red' } } });
    expect(res.statusCode).toBe(400);
    expect(await stored(id)).toEqual({ fail2ban: true, pool: LABELS });
  });
});

describe('HardeningSchema pool', () => {
  it('takes the four labels and nothing else', () => {
    expect(HardeningSchema.safeParse({ pool: { asn: 'AS1', provider: 'p', burned: false, spare: true } }).success).toBe(true);
    expect(HardeningSchema.safeParse({ pool: { extra: 1 } }).success).toBe(false);
    expect(HardeningSchema.safeParse({ pool: { spare: 'yes' } }).success).toBe(false);
  });
});

describe('the install command and the pool labels', () => {
  const flags = { ufwLockdown: true, fail2ban: true, sshAllowlist: ['203.0.113.4'] };

  it('is the same with labels as without', () => {
    const labelled = { ...flags, pool: { spare: true, asn: 'AS1', provider: 'ovh', burned: true } };
    expect(hardeningFlags(labelled)).toEqual(hardeningFlags(flags));
    const a = ['bash install \\', '  --engines xray'];
    const b = [...a];
    appendHardeningFlags(a, labelled);
    appendHardeningFlags(b, flags);
    expect(a).toEqual(b);
  });

  it('a blob of labels only adds no flag', () => {
    expect(hardeningFlags({ pool: { spare: true } })).toEqual([]);
  });
});
