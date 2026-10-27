import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { generateSubscription } from './subscription.service.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import { buildXrayJson } from './formats/xrayjson.js';
import { buildSingboxJson } from './formats/singbox.js';

/**
 * A-133: the XHTTP mode the node waits for, from the profile to every format.
 * A client on its default mode against a server in another one does not
 * connect, and nothing says so.
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

async function xrayEndpoint(config: Record<string, unknown>): Promise<SubscriptionEndpoint> {
  seq += 1;
  const node = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: `xm-node-${seq}`, address: `xm-${seq}.test`, protocol: 'xray' },
  });
  expect(node.statusCode, node.body).toBe(201);
  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name: `xm-profile-${seq}`, protocol: 'xray', config },
  });
  expect(profile.statusCode, profile.body).toBe(201);
  const binding = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth(),
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);
  const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: `xm-user-${seq}` } });
  const { subscriptionToken } = await prisma.user.findFirstOrThrow({
    where: { id: JSON.parse(user.body).id as string },
    select: { subscriptionToken: true },
  });
  const result = await generateSubscription(subscriptionToken, { ip: '127.0.0.1', userAgent: '' });
  const e = result.endpoints.find((x) => x.protocol === 'xray' && x.nodeName === `xm-node-${seq}`);
  expect(e).toBeDefined();
  return e!;
}

const REALITY = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
};

describe('the XHTTP mode', () => {
  it('goes from the profile to the endpoint and into the vless link as mode=', async () => {
    const e = await xrayEndpoint({ ...REALITY, subprotocol: 'vless', network: 'xhttp', path: '/xh', xhttpMode: 'stream-one' });
    expect((e as { xhttpMode?: string }).xhttpMode).toBe('stream-one');
    expect(e.uri).toContain('mode=stream-one');
  });

  it('auto puts no mode in the link', async () => {
    const e = await xrayEndpoint({ ...REALITY, subprotocol: 'vless', network: 'xhttp', path: '/xh', xhttpMode: 'auto' });
    expect(e.uri).not.toContain('mode=');
  });

  it('a trojan link carries it under the same key', async () => {
    const e = await xrayEndpoint({ ...REALITY, subprotocol: 'trojan', network: 'xhttp', path: '/xh', xhttpMode: 'packet-up' });
    expect(e.uri).toContain('mode=packet-up');
  });

  // v2rayN reads 	ype as the XHTTP mode on xhttp (VmessFmt.cs ResolveVmess).
  const vmessJson = (uri: string) => JSON.parse(Buffer.from(uri.slice('vmess://'.length), 'base64').toString('utf8')) as { net: string; type: string };

  it('a vmess link carries the mode in type, auto when the profile says auto', async () => {
    const one = await xrayEndpoint({ subprotocol: 'vmess', security: 'none', network: 'xhttp', path: '/xh', xhttpMode: 'stream-one' });
    expect(vmessJson(one.uri)).toMatchObject({ net: 'xhttp', type: 'stream-one' });
  });

  it('a vmess link on auto says auto, not the header type none', async () => {
    const auto = await xrayEndpoint({ subprotocol: 'vmess', security: 'none', network: 'xhttp', path: '/xh', xhttpMode: 'auto' });
    expect(vmessJson(auto.uri)).toMatchObject({ net: 'xhttp', type: 'auto' });
  });
});

describe('xray-json and sing-box', () => {
  const base = {
    protocol: 'xray' as const,
    nodeName: 'n',
    host: 'n.example.com',
    port: 443,
    uuid: 'uuid-1',
    publicKey: 'PUBKEY',
    shortId: 'SHORT',
    sni: 'www.microsoft.com',
    flow: '',
    fingerprint: 'chrome',
    subprotocol: 'vless' as const,
    securityLayer: 'default' as const,
    uri: '',
  };

  it('xray-json writes the mode, auto when the profile says auto or nothing', () => {
    const json = (mode?: 'stream-one' | 'auto') =>
      buildXrayJson([{ ...base, network: 'xhttp', path: '/xh', ...(mode ? { xhttpMode: mode } : {}) }] as never).replace(/\s+/g, '');
    expect(json('stream-one')).toContain('"mode":"stream-one"');
    expect(json('auto')).toContain('"mode":"auto"');
    expect(json()).toContain('"mode":"auto"');
  });

  it('sing-box leaves out xhttp and kcp, which it has no transport for, instead of dialing bare TCP', () => {
    const out = (
      buildSingboxJson([
        { ...base, nodeName: 'xh', network: 'xhttp' },
        { ...base, nodeName: 'kc', network: 'kcp' },
        { ...base, nodeName: 'ok', network: 'raw' },
      ] as never)
    );
    const vless = (JSON.parse(out) as { outbounds: { type: string; tag: string }[] }).outbounds.filter((o) => o.type === 'vless');
    expect(vless.map((o) => o.tag)).toHaveLength(1);
    expect(vless[0]!.tag).toContain('ok');
  });
});
