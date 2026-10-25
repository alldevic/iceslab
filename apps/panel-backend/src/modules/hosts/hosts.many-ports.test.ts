import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * A-259: a profile on one node on several ports, one binding per port. A host
 * created by profile, node and port goes onto the binding of that port, and a
 * port the pair does not have yet is a binding of its own.
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
async function post(url: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function pair() {
  const node = (await post('/api/nodes', { name: 'mp-node', address: 'mp.test', protocol: 'xray' })).body;
  const profile = (await post('/api/profiles', {
    name: 'mp-xray', protocol: 'xray',
    config: {
      security: 'reality', subprotocol: 'vless', network: 'raw',
      realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
      realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
    },
  })).body;
  return { nodeId: node.id as string, profileId: profile.id as string };
}

describe('a host by profile, node and port', () => {
  it('a port the pair already has reuses its binding; another port is a second binding', async () => {
    const { nodeId, profileId } = await pair();
    const first = await post('/api/hosts', { profileId, nodeId, port: 443, remark: 'Direct' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const same = await post('/api/hosts', { profileId, nodeId, port: 443, remark: 'CDN' });
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    expect(same.body.bindingId).toBe(first.body.bindingId);

    const other = await post('/api/hosts', { profileId, nodeId, port: 8443, remark: 'Alt' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.bindingId).not.toBe(first.body.bindingId);

    const bindings = await prisma.profileNodeBinding.findMany({ where: { profileId, nodeId }, orderBy: { port: 'asc' } });
    expect(bindings.map((b) => b.port)).toEqual([443, 8443]);
  });

  it('the new port is checked as any new binding: a port another profile holds is refused', async () => {
    const { nodeId, profileId } = await pair();
    await post('/api/hosts', { profileId, nodeId, port: 443, remark: 'Direct' });
    const other = (await post('/api/profiles', {
      name: 'mp-other', protocol: 'xray',
      config: {
        security: 'reality', subprotocol: 'vless', network: 'raw',
        realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
      },
    })).body;
    await post('/api/hosts', { profileId: other.id, nodeId, port: 9443, remark: 'Theirs' });
    const taken = await post('/api/hosts', { profileId, nodeId, port: 9443, remark: 'Mine' });
    expect(taken.status).toBe(409);
    expect(await prisma.profileNodeBinding.count({ where: { profileId, nodeId } })).toBe(1);
  });
});
