import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';

/**
 * 11.5: a sing-box entry whose protocol the entry node serves on another core.
 * shadowsocks is native to xray; the block names the sing-box instance of that
 * protocol, there is none, and the profile's users would leave directly while
 * the subscription calls the line a cascade. Refused at the save.
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

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload: payload as object });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function makeNode(name: string) {
  seq += 1;
  return post('/api/nodes', { name, address: `${name}-${seq}.test`, protocol: 'xray' });
}

async function shadowsocksOn(nodeId: string, engine?: 'xray' | 'singbox') {
  const profileId = await post('/api/profiles', {
    name: `ss-${engine ?? 'native'}`,
    protocol: 'shadowsocks',
    config: { method: 'aes-256-gcm' },
    ...(engine ? { engine } : {}),
  });
  await post('/api/bindings', { profileId, nodeId, port: 8388 });
}

function save(entry: string, exit: string, protocol: string) {
  seq += 1;
  return app.inject({
    method: 'POST',
    url: '/api/cascades',
    headers: auth(),
    payload: {
      name: `ru-${seq}`,
      enabled: true,
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: protocol, linkProtocol: 'vless' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    },
  });
}

describe('a sing-box entry on a profile another core serves', () => {
  it('refuses shadowsocks served by xray (native), naming the profile', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    await shadowsocksOn(entry);
    const res = await save(entry, exit, 'shadowsocks');
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ENTRY_PROTOCOL_NOT_ON_SINGBOX');
    expect(body.conflicts).toEqual([{ nodeName: 'ru-entry', profileName: 'ss-native', engine: 'xray' }]);
    expect(await prisma.cascade.count()).toBe(0);
  });

  it('refuses shadowsocks pinned to xray as well', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    await shadowsocksOn(entry, 'xray');
    expect((await save(entry, exit, 'shadowsocks')).statusCode).toBe(409);
  });

  it('lets shadowsocks pinned to sing-box through', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    await shadowsocksOn(entry, 'singbox');
    expect((await save(entry, exit, 'shadowsocks')).statusCode).toBe(201);
  });

  it('does not ask about an entry with no profile of that protocol yet', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    expect((await save(entry, exit, 'shadowsocks')).statusCode).toBe(201);
  });
});
