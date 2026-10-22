import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { observedCores } from './nodes.cron.js';

/**
 * A-055: a node does not get a second inbound on an adapter that holds one.
 * The agent would silently replace the first with it, and the operator would
 * see two hosts while the node serves one. Asked on both ways a binding is
 * born: the bindings route and creating a host.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

const VLESS = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function node(): Promise<string> {
  seq += 1;
  const r = await post('/api/nodes', { name: `slot-${seq}`, address: `slot-${seq}.test`, protocol: 'xray' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function profile(protocol: string, config: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const r = await post('/api/profiles', { name: `slot-p-${seq}`, protocol, config, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const awg = (subnet: string) => ({
  serverPrivateKey: 'a'.repeat(44),
  serverPublicKey: 'b'.repeat(44),
  subnet,
  obfuscation: {},
});

describe('one inbound per adapter where the agent holds one', () => {
  it('a second vless on the sing-box engine is refused, by host route and bindings route alike', async () => {
    const n = await node();
    const a = await profile('xray', VLESS, { engine: 'singbox' });
    const b = await profile('xray', VLESS, { engine: 'singbox' });
    const c = await profile('xray', VLESS, { engine: 'singbox' });
    expect((await post('/api/hosts', { profileId: a, nodeId: n, port: 443, remark: 'First' })).status).toBe(201);

    const viaHost = await post('/api/hosts', { profileId: b, nodeId: n, port: 8443, remark: 'Second' });
    expect(viaHost.status).toBe(409);
    expect(viaHost.body).toMatchObject({ error: 'ADAPTER_SLOT_TAKEN', protocol: 'xray', engine: 'singbox', heldBy: 'First' });

    const viaBinding = await post('/api/bindings', { profileId: c, nodeId: n, port: 9443 });
    expect(viaBinding.status).toBe(409);
    expect(viaBinding.body.error).toBe('ADAPTER_SLOT_TAKEN');
  });

  it('vless on native xray takes as many as the operator wants', async () => {
    const n = await node();
    const a = await profile('xray', VLESS);
    const b = await profile('xray', VLESS);
    expect((await post('/api/hosts', { profileId: a, nodeId: n, port: 443 })).status).toBe(201);
    expect((await post('/api/hosts', { profileId: b, nodeId: n, port: 8443 })).status).toBe(201);
  });

  it('AmneziaWG 1.x and 3.1 sit side by side; a second 1.x is refused', async () => {
    const n = await node();
    await prisma.node.update({
      where: { id: n },
      data: {
        cores: observedCores(
          [{ name: 'amneziawg', engine: 'amneziawg', running: true, installed: true, awgProtocol: 3, awgGenerations: [1, 3] }],
          new Date().toISOString(),
        ) as unknown as object,
      },
    });
    const one = await profile('amneziawg', awg('10.66.66.0/24'));
    const three = await profile('amneziawg', awg('10.67.67.0/24'), { awgProtocol: 3 });
    const another = await profile('amneziawg', awg('10.68.68.0/24'));
    expect((await post('/api/bindings', { profileId: one, nodeId: n, port: 51820 })).status).toBe(201);
    const r3 = await post('/api/bindings', { profileId: three, nodeId: n, port: 51830 });
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);
    const r1 = await post('/api/bindings', { profileId: another, nodeId: n, port: 51840 });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ error: 'ADAPTER_SLOT_TAKEN', protocol: 'amneziawg', engine: 'AmneziaWG 1.x' });
  });

  it('a bound profile moved onto a taken adapter (engine switch) is refused, naming the node', async () => {
    const n = await node();
    const onSingbox = await profile('xray', VLESS, { engine: 'singbox' });
    const onXray = await profile('xray', VLESS);
    expect((await post('/api/hosts', { profileId: onSingbox, nodeId: n, port: 443, remark: 'SB' })).status).toBe(201);
    expect((await post('/api/hosts', { profileId: onXray, nodeId: n, port: 8443, remark: 'XR' })).status).toBe(201);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${onXray}`,
      headers: auth(),
      payload: { engine: 'singbox' },
    });
    expect(res.statusCode, res.body).toBe(409);
    const nodeName = (await prisma.node.findUniqueOrThrow({ where: { id: n } })).name;
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ADAPTER_SLOT_TAKEN', nodeName, heldBy: 'SB' });
    expect((await prisma.profile.findUniqueOrThrow({ where: { id: onXray } })).engine).toBeNull();
  });

  it('mieru takes several inbounds (agent f8bac16), all on one MTU', async () => {
    const n = await node();
    const a = await profile('mieru', { mtu: 1400 });
    const b = await profile('mieru', {});
    const c = await profile('mieru', { mtu: 1280 });
    expect((await post('/api/bindings', { profileId: a, nodeId: n, port: 2012 })).status).toBe(201);
    // No MTU given is the default, 1400: the same.
    expect((await post('/api/hosts', { profileId: b, nodeId: n, port: 2013 })).status).toBe(201);
    const other = await post('/api/bindings', { profileId: c, nodeId: n, port: 2014 });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: 'MIERU_MTU_MISMATCH', mtu: 1400, wanted: 1280 });
  });

  it('an MTU edit of a bound mieru profile beside another is refused too', async () => {
    const n = await node();
    const a = await profile('mieru', { mtu: 1400 });
    const b = await profile('mieru', { mtu: 1400 });
    expect((await post('/api/bindings', { profileId: a, nodeId: n, port: 2012 })).status).toBe(201);
    expect((await post('/api/bindings', { profileId: b, nodeId: n, port: 2013 })).status).toBe(201);
    const res = await app.inject({ method: 'PUT', url: `/api/profiles/${b}`, headers: auth(), payload: { config: { mtu: 1280 } } });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error).toBe('MIERU_MTU_MISMATCH');
  });

  it('a second hysteria on its native core is refused', async () => {
    const n = await node();
    const a = await profile('hysteria', {});
    const b = await profile('hysteria', {});
    expect((await post('/api/bindings', { profileId: a, nodeId: n, port: 443 })).status).toBe(201);
    expect((await post('/api/bindings', { profileId: b, nodeId: n, port: 8443 })).body.error).toBe('ADAPTER_SLOT_TAKEN');
  });
});
