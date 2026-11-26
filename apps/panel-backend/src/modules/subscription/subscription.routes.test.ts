import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';
import { deriveSsPassword } from '../../lib/auth/credentials.js';
import { REALITY_TEST_PRIVATE_KEY, REALITY_TEST_PUBLIC_KEY } from '../../../tests/helpers/reality-keys.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';

let app: FastifyInstance;
let token: string;

async function createUser(
  username: string,
  enabledProtocols?: string[],
): Promise<{
  id: string;
  subscriptionToken: string;
  hysteriaPassword: string;
  xrayUuid: string;
}> {
  const payload: Record<string, unknown> = { username };
  if (enabledProtocols) payload.enabledProtocols = enabledProtocols;
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  if (res.statusCode !== 201) {
    throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
  }
  const body = JSON.parse(res.body);
  // Subscription token is in the public DTO; hysteriaPassword/xrayUuid aren't,
  // so pull them directly from the DB for assertions.
  const persisted = await prisma.user.findUniqueOrThrow({
    where: { id: body.id },
    select: { hysteriaPassword: true, xrayUuid: true },
  });
  return {
    id: body.id,
    subscriptionToken: body.subscriptionToken,
    hysteriaPassword: persisted.hysteriaPassword,
    xrayUuid: persisted.xrayUuid,
  };
}

/**
 * Test helper: creates a node + a Hysteria profile-binding on port 443.
 * Slice 27: inbounds split into Profile (template) + ProfileNodeBinding
 * (per-node deployment). Each call creates a fresh profile so subscription
 * sees the binding through the auto-attached "All" squad.
 */
async function createNode(name: string, address: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, address },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createNode failed: ${res.statusCode} ${res.body}`);
  }
  const nodeId = JSON.parse(res.body).id as string;
  await createHysteriaInbound(nodeId);
  return nodeId;
}

async function createProfile(
  protocol: string,
  config: Record<string, unknown>,
  nameSuffix: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: `${protocol}-${nameSuffix}`,
      protocol,
      config,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createProfile failed: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body).id;
}

async function createBinding(profileId: string, nodeId: string, port: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: { authorization: `Bearer ${token}` },
    payload: { profileId, nodeId, port },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createBinding failed: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body).id;
}

async function createHysteriaInbound(nodeId: string, port = 443): Promise<string> {
  // Each call creates a fresh per-node profile so port collisions don't
  // happen across nodes and we mimic the pre-slice-27 "one inbound per
  // (node, port)" shape the existing assertions expect.
  const profileId = await createProfile('hysteria', {}, `${nodeId.slice(0, 6)}-${port}`);
  return createBinding(profileId, nodeId, port);
}

async function createXrayInbound(nodeId: string, port = 8443): Promise<string> {
  const profileId = await createProfile(
    'xray',
    {
      realityDest: 'www.cloudflare.com:443',
      realityServerNames: ['www.cloudflare.com'],
      realityShortIds: ['abc123'],
      realityPrivateKey: REALITY_TEST_PRIVATE_KEY,
      realityPublicKey: REALITY_TEST_PUBLIC_KEY,
    },
    `${nodeId.slice(0, 6)}-${port}`,
  );
  return createBinding(profileId, nodeId, port);
}

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache(); // the SRR service caches compiled rules; reset between tests
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('GET /sub/:token (default text/plain)', () => {
  it('returns base64-encoded URI list with one entry per active node', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');
    await createNode('us-1', '10.0.0.2:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const decoded = Buffer.from(res.body, 'base64').toString('utf8');
    const lines = decoded.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^hysteria2:\/\//);
      expect(line).toContain(encodeURIComponent(user.hysteriaPassword));
    }
    // Host extracted from node.address; the client-facing port comes from the
    // BINDING, independent of the control-plane port baked into nodes.address.
    // (This used to say "forced to HYSTERIA_PUBLIC_PORT". That env var no
    // longer exists, and 443 here is the fixture's binding port.)
    expect(lines[0]).toContain('10.0.0.1:443');
    expect(lines[0]).toContain('eu-1');
  });

  it('returns an empty base64 body when no nodes exist', async () => {
    const user = await createUser('alice');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });

    expect(res.statusCode).toBe(200);
    const decoded = Buffer.from(res.body, 'base64').toString('utf8');
    expect(decoded).toBe('');
  });
});

describe('GET /sub/:token (JSON format)', () => {
  it('returns structured JSON when ?format=json', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=json`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = JSON.parse(res.body);
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe('alice');
    expect(body.user.status).toBe('active');
    expect(body.user.trafficUsedBytes).toBe(0);
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].protocol).toBe('hysteria');
    expect(body.endpoints[0].nodeName).toBe('eu-1');
    expect(body.endpoints[0].uri).toMatch(/^hysteria2:\/\//);
  });

  it('refuses a format it does not serve, by name', async () => {
    // A client asking for something this build has no builder for used to get
    // a bare 400 from the schema: no way to tell a typo from a panel older
    // than the client. The reader is usually a config file, but the person
    // debugging it needs the sentence.
    const user = await createUser('alice');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=mieru-json`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('UNKNOWN_FORMAT');
    expect(body.message).toContain('mieru-json');
    // And it lists what IS served, so the answer is actionable on its own.
    expect(body.message).toContain('clash');
    expect(body.message).toContain('xrayjson-array');
  });

  it('returns JSON when Accept: application/json', async () => {
    const user = await createUser('alice');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: { accept: 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.user.username).toBe('alice');
  });
});

describe('GET /sub/:token - SRR auto-format (slice 22)', () => {
  it('selects format from a UA rule when no ?format= is given', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    await prisma.subscriptionResponseRule.create({
      data: {
        name: 'Hiddify',
        uaPattern: 'Hiddify',
        format: 'singbox',
        priority: 10,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: { 'user-agent': 'Hiddify/2.5.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const cfg = JSON.parse(res.body);
    // singbox shape, not the simpler /sub JSON shape
    expect(cfg.outbounds).toBeDefined();
    expect(cfg.route).toBeDefined();
  });

  it('explicit ?format= still wins over a matching SRR rule', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');
    await prisma.subscriptionResponseRule.create({
      data: { name: 'Hiddify', uaPattern: 'Hiddify', format: 'singbox', priority: 10 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=clash`,
      headers: { 'user-agent': 'Hiddify/2.5.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
  });

  it('falls back to plain when UA does not match any rule', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');
    await prisma.subscriptionResponseRule.create({
      data: { name: 'Hiddify', uaPattern: 'Hiddify', format: 'singbox', priority: 10 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: { 'user-agent': 'curl/8.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('GET /sub/:token - multi-format (slice 21)', () => {
  it('returns Clash YAML when ?format=clash', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=clash`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.body).toContain('proxies:');
    expect(res.body).toContain('type: hysteria2');
    expect(res.body).toContain('eu-1-hysteria');
    expect(res.body).toContain('- MATCH,Auto');
  });

  it('returns Sing-box JSON when ?format=singbox', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=singbox`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const cfg = JSON.parse(res.body);
    expect(cfg.outbounds.find((o: { type: string }) => o.type === 'hysteria2')).toBeDefined();
    expect(cfg.outbounds.find((o: { tag: string }) => o.tag === 'Auto')).toBeDefined();
    expect(cfg.route.final).toBe('Auto');
  });

  it('returns Xray JSON when ?format=xrayjson', async () => {
    const user = await createUser('alice', ['hysteria', 'xray']);
    const nodeId = await createNode('eu-1', '10.0.0.1:8443');
    await createXrayInbound(nodeId);

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=xrayjson`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const cfg = JSON.parse(res.body);
    expect(cfg.inbounds[0].protocol).toBe('socks');
    const v = cfg.outbounds.find((o: { protocol: string }) => o.protocol === 'vless');
    // The tag is the endpoint's identity, not its display name: it survives
    // renaming the node, and it is what the catch-all rule points at.
    expect(v.tag).toMatch(/^proxy-[0-9a-f]{8}$/);
    const catchAll = cfg.routing.rules[cfg.routing.rules.length - 1];
    expect(catchAll.outboundTag).toBe(v.tag);
    expect(v.streamSettings.network).toBe('raw');
  });

  it('returns empty wgconf body when user has no AmneziaWG endpoint', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=wgconf`,
    });
    expect(res.statusCode).toBe(200);
    // 9.8, the one deliberate change of a base assertion: was text/plain.
    // Android derives the saved file's extension from the type and, for
    // text/plain, appends `.txt` to `.conf`.
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.conf"$/);
    expect(res.body).toBe('');
  });

  it('?format=outline answers one Shadowsocks server, &node= picks which', async () => {
    const user = await createUser('alice');
    const eu1 = await createNode('eu-1', '10.0.0.1:8443');
    const eu2 = await createNode('eu-2', '10.0.0.2:8443');
    const eu3 = await createNode('eu-3', '10.0.0.3:8443');
    const aead = await createProfile('shadowsocks', { method: 'chacha20-ietf-poly1305' }, 'aead');
    await createBinding(aead, eu1, 8388);
    await createBinding(aead, eu2, 8388);
    // Outline has no 2022-blake3: this node must never come back as a key body.
    const ss2022 = await createProfile('shadowsocks', { method: '2022-blake3-aes-128-gcm' }, 's22');
    await createBinding(ss2022, eu3, 8389);

    const get = (q: string) =>
      app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=outline${q}` });
    // `node` is the endpoint's label, the name the page puts in the key.
    const node = (n: string) => `&node=${encodeURIComponent(`${n} · Shadowsocks`)}`;

    const picked = await get(node('eu-2'));
    expect(picked.statusCode).toBe(200);
    expect(picked.headers['content-type']).toContain('application/json');
    const body = JSON.parse(picked.body);
    expect(Object.keys(body)).toEqual(['server', 'server_port', 'method', 'password']);
    expect(body).toMatchObject({ server: '10.0.0.2', server_port: 8388, method: 'chacha20-ietf-poly1305' });

    // Without node: the first Outline can read IN THIS USER'S ORDER. The order
    // is a rendezvous hash on (user, node), so which node that is changes from
    // user to user and is read off the subscription itself, not assumed.
    const eps = JSON.parse(
      (await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=json` })).body,
    ).endpoints as Array<{ protocol: string; method?: string; host: string }>;
    const firstAead = eps.find((e) => e.protocol === 'shadowsocks' && e.method === 'chacha20-ietf-poly1305')!;
    const first = JSON.parse((await get('')).body);
    expect(first).toMatchObject({ server: firstAead.host, method: 'chacha20-ietf-poly1305' });

    // E54: a node the format cannot read, and a node there is not, each a
    // 404 in words with the names there are, not an empty 200.
    const unreadable = await get(node('eu-3'));
    expect(unreadable.statusCode).toBe(404);
    expect(JSON.parse(unreadable.body)).toMatchObject({ error: 'SUBSCRIPTION_NODE_UNKNOWN', node: 'eu-3 · Shadowsocks' });
    expect(JSON.parse(unreadable.body).message).toMatch(/^the outline format cannot carry the server "eu-3 · Shadowsocks"/);
    const nowhere = await get('&node=nowhere');
    expect(nowhere.statusCode).toBe(404);
    expect(JSON.parse(nowhere.body)).toMatchObject({ error: 'SUBSCRIPTION_NODE_UNKNOWN', node: 'nowhere' });
    expect(JSON.parse(nowhere.body).nodes.sort()).toEqual(['eu-1 · Shadowsocks', 'eu-2 · Shadowsocks']);
    expect(JSON.parse(nowhere.body).message).toMatch(/^this subscription has no shadowsocks server named "nowhere"/);
  });

  it('hands a legacy AEAD client its own key alone, an SS2022 client server:user (E19)', async () => {
    const user = await createUser('alice');
    const eu1 = await createNode('eu-1', '10.0.0.1:8443');
    const eu2 = await createNode('eu-2', '10.0.0.2:8443');
    await createBinding(await createProfile('shadowsocks', { method: 'chacha20-ietf-poly1305' }, 'aead'), eu1, 8388);
    await createBinding(await createProfile('shadowsocks', { method: '2022-blake3-aes-128-gcm' }, 's22'), eu2, 8389);
    const psk = (method: string) => deriveSsPassword(user.xrayUuid, method);

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=json` });
    const ss = (JSON.parse(res.body).endpoints as Array<{ protocol: string; method?: string; password?: string; uri: string }>)
      .filter((e) => e.protocol === 'shadowsocks');
    const aead = ss.find((e) => e.method === 'chacha20-ietf-poly1305')!;
    const s22 = ss.find((e) => e.method === '2022-blake3-aes-128-gcm')!;

    // The panel stores a serverPsk on the legacy profile too; it must not reach
    // the client, in the field every format reads nor in the link.
    expect(aead.password).toBe(psk('chacha20-ietf-poly1305'));
    const userinfo = (uri: string) =>
      Buffer.from(uri.slice('ss://'.length, uri.indexOf('@')), 'base64url').toString('utf8');
    expect(userinfo(aead.uri)).toBe(`chacha20-ietf-poly1305:${psk('chacha20-ietf-poly1305')}`);

    // SS2022 as it was: the server key, a colon, the user key.
    expect(s22.password).toMatch(new RegExp(`^[^:]+:${psk('2022-blake3-aes-128-gcm').replace(/[+/=]/g, '\\$&')}$`));
    expect(userinfo(s22.uri)).toBe(`2022-blake3-aes-128-gcm:${s22.password}`);
  });

  it('rejects unknown ?format value with 400', async () => {
    const user = await createUser('alice');
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=bogus`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('explicit ?format=plain wins over Accept: application/json', async () => {
    const user = await createUser('alice');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=plain`,
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // body is base64, not JSON
    expect(() => JSON.parse(res.body)).toThrow();
  });
});

describe('GET /sub/:token - error cases', () => {
  it('returns 404 for unknown token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sub/this-token-does-not-exist-anywhere',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for soft-deleted user', async () => {
    const user = await createUser('gone');
    await prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });
    // soft-deleted user is invisible, looks like an unknown token (404)
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 REVOKED when subRevokedAt is set', async () => {
    const user = await createUser('rev');
    await prisma.user.update({
      where: { id: user.id },
      data: { subRevokedAt: new Date() },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('REVOKED');
  });

  it('returns 403 DISABLED when status=disabled', async () => {
    const user = await createUser('dis');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'disabled' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('DISABLED');
  });

  it('returns 403 EXPIRED when status=expired', async () => {
    const user = await createUser('exp');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'expired' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('EXPIRED');
  });

  it('returns 403 LIMITED when status=limited', async () => {
    const user = await createUser('lim');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'limited' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe('LIMITED');
  });
});

describe('GET /sub/:token - multi-protocol (slice 18)', () => {
  it('user with enabledProtocols=["hysteria","xray"] gets both endpoints per node', async () => {
    const user = await createUser('alice', ['hysteria', 'xray']);
    const nodeId = await createNode('eu-1', '10.0.0.1:8443');
    await createXrayInbound(nodeId);

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=json`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.endpoints).toHaveLength(2);
    const protocols = body.endpoints.map((e: { protocol: string }) => e.protocol).sort();
    expect(protocols).toEqual(['hysteria', 'xray']);

    const xray = body.endpoints.find((e: { protocol: string }) => e.protocol === 'xray');
    expect(xray.uri).toMatch(/^vless:\/\//);
    expect(xray.uri).toContain(user.xrayUuid);
    expect(xray.uri).toContain('security=reality');
    expect(xray.uri).toContain('sid=abc123');
  });

  it('user with enabledProtocols=["hysteria"] only gets hysteria endpoints', async () => {
    const user = await createUser('bob', ['hysteria']);
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=json`,
    });

    const body = JSON.parse(res.body);
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].protocol).toBe('hysteria');
  });

  it('default user (no enabledProtocols passed) gets hysteria-only', async () => {
    const user = await createUser('carol');
    await createNode('eu-1', '10.0.0.1:8443');

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=json`,
    });

    const body = JSON.parse(res.body);
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].protocol).toBe('hysteria');
    expect(body.user.id).toBe(user.id);
  });
});

describe('GET /sub/:token - audit', () => {
  it('writes a row to subscription_request_history', async () => {
    const user = await createUser('alice');

    const before = await prisma.subscriptionRequestHistory.count({
      where: { userId: user.id },
    });

    await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: {
        'user-agent': 'test-client/1.0',
        'x-forwarded-for': '203.0.113.1',
      },
    });

    const after = await prisma.subscriptionRequestHistory.findMany({
      where: { userId: user.id },
      orderBy: { requestedAt: 'desc' },
    });
    expect(after.length).toBe(before + 1);
    expect(after[0]!.userAgent).toBe('test-client/1.0');
  });
});

describe('a subscription that is not in force', () => {
  /**
   * The worst page of the product used to be the one a lapsed subscriber saw:
   * a raw JSON error object, shown to exactly the person worth getting back.
   *
   * The rule is narrow. Only a request already recognised as a browser asking
   * for a page gets HTML; the status stays 403; everyone else gets the same
   * JSON, byte for byte, so anything reading that 403 sees no change at all.
   */
  const browser = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };

  it('shows the page, and still answers 403', async () => {
    const user = await createUser('lapsed');
    await createNode('lapsed-n', '10.0.0.31:8443');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'expired' } });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: browser,
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('lapsed');
    // It says what happened and what to do, not "FORBIDDEN".
    expect(res.body).toContain('Renew it');
    expect(res.body).not.toContain('"error":"FORBIDDEN"');
  });

  it('leaves the JSON refusal exactly as it was for everyone else', async () => {
    const user = await createUser('lapsed-2');
    await createNode('lapsed-n2', '10.0.0.32:8443');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'expired' } });

    const cases: Array<[Record<string, string>, string]> = [
      [{}, ''],
      [{ 'user-agent': 'Happ/1.0' }, ''],
      [{ accept: 'application/json' }, ''],
      // A browser that asked for a FORMAT is a client, not a reader: the
      // page is only for the request that wanted a page.
      [browser, '?format=clash'],
    ];
    for (const [headers, qs] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/sub/${user.subscriptionToken}${qs}`,
        headers,
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        error: 'FORBIDDEN',
        message: 'Subscription is expired',
        reason: 'EXPIRED',
      });
    }
  });

  it('never calls a withdrawn subscription active', async () => {
    // A revoked link belongs to a user whose row still says `active`, and
    // that is the one word this page must not print to somebody it has just
    // turned away. The refusal decides the wording, not the stored status.
    const user = await createUser('revoked-1');
    await createNode('revoked-n', '10.0.0.33:8443');
    await prisma.user.update({ where: { id: user.id }, data: { subRevokedAt: new Date() } });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: browser,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('withdrawn');
    expect(res.body).not.toContain('>active<');
  });

  it('offers nothing it cannot deliver', async () => {
    /**
     * The live question the previous version of this test recorded is now
     * settled, and the other way round: the refusal page carries the state
     * card, the link with its copy button, and support. Nothing else.
     *
     * The downloads block used to stay with an amber plate, and the install
     * block appeared through the branch built for a WORKING subscription whose
     * fleet is unreachable. On a refused one that branch offered apps whose
     * one-tap import leads straight back to the 403 that produced the page.
     */
    const user = await createUser('lapsed-3');
    await createNode('lapsed-n3', '10.0.0.34:8443');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'limited' } });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}`,
      headers: browser,
    });
    expect(res.statusCode).toBe(403);
    // Nothing that would lead the reader into the same refusal.
    expect(res.body).not.toContain('id="downloads"');
    expect(res.body).not.toContain('data-platform=');
    expect(res.body).not.toContain('format=plain');
    expect(res.body).not.toContain('data-copy-config="');
    // The three that remain, end to end through the real route.
    expect(res.body).toContain('sub-card');
    expect(res.body).toContain(user.subscriptionToken);
    expect(res.body).toContain('id="copy-inline"');
    expect(res.body).toContain('The link does not change');
  });
});

describe('a stored config that is missing fields', () => {
  /**
   * `config` is jsonb. The zod schema defaults the REALITY arrays and the
   * AmneziaWG obfuscation block, but only on the way in through the API: a row
   * written by a seed script, by the migrate tool importing a foreign panel,
   * or by hand has whatever it has.
   *
   * Found on the local stand 2026-09-21. One seeded profile with no
   * `realityServerNames` answered 500 for EVERY user and EVERY format,
   * including users whose other endpoints were fine, because this loop builds
   * the whole subscription in one pass. The blast radius is what makes it
   * worth a test: one bad row took out the product.
   */
  it('still serves the subscription when a REALITY profile has no serverNames', async () => {
    const user = await createUser('jsonb-1');
    const nodeId = await createNode('jsonb-n1', '10.0.0.41:8443');
    const profileId = await createProfile(
      'xray',
      {
        realityDest: 'www.cloudflare.com:443',
        realityServerNames: ['www.cloudflare.com'],
        realityShortIds: ['abc123'],
        realityPrivateKey: REALITY_TEST_PRIVATE_KEY,
        realityPublicKey: REALITY_TEST_PUBLIC_KEY,
      },
      'jsonb-x',
    );
    await createBinding(profileId, nodeId, 9443);
    // The shape a seed leaves behind: the security mode says REALITY and the
    // fields it needs are simply absent.
    await prisma.profile.update({
      where: { id: profileId },
      data: { config: { security: 'reality', realityDest: 'www.cloudflare.com:443' } },
    });

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}` });
    expect(res.statusCode).toBe(200);
    // The hysteria endpoint from createNode is still there: one broken profile
    // must not take the working ones with it.
    const decoded = Buffer.from(res.body, 'base64').toString('utf8');
    expect(decoded).toContain('hysteria2://');
  });

  it('skips an AmneziaWG profile with no obfuscation instead of failing, or guessing', async () => {
    // Eleven numbers with no safe default: Jc/S/H decide what the traffic
    // looks like on the wire. Zeros would hand out a .conf that connects to
    // nothing, or connects and is conspicuous. So the endpoint is dropped and
    // the log says which profile to re-save.
    const user = await createUser('jsonb-2');
    const nodeId = await createNode('jsonb-n2', '10.0.0.42:8443');
    const profileId = await createProfile(
      'amneziawg',
      {
        subnet: '10.66.66.0/24',
        serverPrivateKey: WG_TEST_PRIVATE_KEY,
        serverPublicKey: WG_TEST_PUBLIC_KEY,
        obfuscation: {},
      },
      'jsonb-awg',
    );
    await createBinding(profileId, nodeId, 51820);
    await prisma.profile.update({
      where: { id: profileId },
      data: { config: { subnet: '10.66.66.0/24', serverPublicKey: WG_TEST_PUBLIC_KEY } },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=json`,
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.endpoints.some((e: { protocol: string }) => e.protocol === 'amneziawg')).toBe(false);
    expect(body.endpoints.some((e: { protocol: string }) => e.protocol === 'hysteria')).toBe(true);
  });
});

describe('the download flag', () => {
  /**
   * `&dl=1` says "save this", and it is a flag of its own rather than a
   * property of the format.
   *
   * The format addresses are a contract: `?format=clash` and
   * `?format=singbox` get pasted into apps and polled for months. Attaching a
   * Content-Disposition to them would probably change nothing, because a
   * programmatic fetch ignores the header, and "probably" is not a reason to
   * alter an address somebody else depends on.
   */
  it('leaves the plain addresses exactly as they were', async () => {
    const user = await createUser('dl-1');
    await createNode('dl-n1', '10.0.0.21:8443');
    for (const url of [
      `/sub/${user.subscriptionToken}?format=clash`,
      `/sub/${user.subscriptionToken}?format=singbox`,
      `/sub/${user.subscriptionToken}`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-disposition'], url).toBeUndefined();
    }
  });

  it('turns a response into a file when asked, with a name that tells them apart', async () => {
    const user = await createUser('dl-2');
    await createNode('dl-n2', '10.0.0.22:8443');
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=clash&dl=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="dl-2-clash.yaml"');
    // The body is untouched: this is the same response, delivered differently.
    expect(res.headers['content-type']).toContain('text/yaml');
  });

  it('never attaches the flag to the raw subscription', async () => {
    // `plain` is what a client pulls from the bare link. It is the one address
    // that must behave identically with the flag and without it.
    const user = await createUser('dl-3');
    await createNode('dl-n3', '10.0.0.23:8443');
    const withFlag = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=plain&dl=1`,
    });
    const without = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=plain`,
    });
    expect(withFlag.headers['content-disposition']).toBeUndefined();
    expect(withFlag.body).toBe(without.body);
  });

  it('does not disturb the formats that already sent a filename', async () => {
    // wgconf and xkeen attached one unconditionally long before this flag
    // existed, and theirs is the better name (it carries the node).
    const user = await createUser('dl-4');
    await createNode('dl-n4', '10.0.0.24:8443');
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=xkeen`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="dl-4-xkeen.json"');
  });
});

describe('the page offers only the clients whose format gives them a server', () => {
  const browser = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };
  const REALITY = {
    security: 'reality',
    realityDest: 'www.microsoft.com:443',
    realityServerNames: ['www.microsoft.com'],
    realityPrivateKey: 'k'.repeat(43),
    realityPublicKey: 'p'.repeat(43),
    realityShortIds: ['0123abcd'],
    subprotocol: 'vless',
    path: '/xh',
  };

  async function xrayFleet(network: string, username: string): Promise<string> {
    const node = await app.inject({
      method: 'POST', url: '/api/nodes', headers: { authorization: `Bearer ${token}` },
      payload: { name: `usable-${network}`, address: `usable-${network}.test`, protocol: 'xray' },
    });
    const profile = await app.inject({
      method: 'POST', url: '/api/profiles', headers: { authorization: `Bearer ${token}` },
      payload: { name: `usable-p-${network}`, protocol: 'xray', config: { ...REALITY, network } },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const binding = await app.inject({
      method: 'POST', url: '/api/bindings', headers: { authorization: `Bearer ${token}` },
      payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
    });
    expect(binding.statusCode, binding.body).toBe(201);
    return (await createUser(username)).subscriptionToken;
  }

  it('hides sing-box clients on an all-XHTTP fleet, and shows them on a raw one', async () => {
    const xhttp = await app.inject({ method: 'GET', url: `/sub/${await xrayFleet('xhttp', 'u-xhttp')}`, headers: browser });
    expect(xhttp.statusCode, xhttp.body).toBe(200);
    expect(xhttp.body).toContain('happ://add/');
    expect(xhttp.body).not.toContain('sing-box://import-remote-profile');
    expect(xhttp.body).not.toContain('hiddify://import/');

    await cleanDatabase();
    token = await registerAndLogin(app);
    const raw = await app.inject({ method: 'GET', url: `/sub/${await xrayFleet('raw', 'u-raw')}`, headers: browser });
    expect(raw.statusCode, raw.body).toBe(200);
    expect(raw.body).toContain('sing-box://import-remote-profile');
    expect(raw.body).toContain('hiddify://import/');
  });
});

describe('tunnels: the page and `configUrls` follow the files the route serves', () => {
  interface Ep { protocol: string; nodeName: string; configUrls?: { wgconf?: string; amneziavpn?: string } }
  const withoutUrls = (eps: Ep[]) => eps.map((e) => ({ ...e, configUrls: undefined }));
  const browser = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };
  // A host edit reaches /sub through the bindings cache's bus subscription.
  beforeAll(() => registerBindingsCacheBust());
  const AWG = { subnet: '10.66.66.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY, obfuscation: {} };
  const WG = { subnet: '10.77.77.0/24', serverPrivateKey: WG_TEST_PRIVATE_KEY, serverPublicKey: WG_TEST_PUBLIC_KEY };

  async function bareNode(name: string, address: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/nodes', headers: { authorization: `Bearer ${token}` }, payload: { name, address },
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  /** AmneziaWG on two nodes, plain WireGuard on the first, xray on the first. */
  async function tunnelFleet(): Promise<{ sub: string; one: string; two: string }> {
    const one = await bareNode('awg-one', '10.0.0.41:8443');
    const two = await bareNode('awg-two', '10.0.0.42:8443');
    await createBinding(await createProfile('amneziawg', AWG, 'one'), one, 51820);
    await createBinding(await createProfile('amneziawg', { ...AWG, subnet: '10.66.67.0/24' }, 'two'), two, 51820);
    await createBinding(await createProfile('wireguard', WG, 'wg'), one, 51830);
    await createXrayInbound(one, 8443);
    const user = await createUser('tunneler');
    return { sub: user.subscriptionToken, one, two };
  }

  /** Through the API, so the bindings cache learns of it (a direct write would not). */
  async function disableHosts(nodeId: string, formats: string[]): Promise<void> {
    const hosts = await prisma.host.findMany({ where: { binding: { nodeId } }, select: { id: true } });
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) {
      const res = await app.inject({
        method: 'PUT', url: `/api/hosts/${h.id}`, headers: { authorization: `Bearer ${token}` }, payload: { disableForFormats: formats },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }

  const qrTargets = (html: string) => [...html.matchAll(/<figure class="qrf[^"]*" data-target="([^"]+)"/g)].map((m) => m[1]!.replace(/ · .*$/, ''));
  const fileRows = (html: string, fmt: string) => [...html.matchAll(new RegExp(`format=${fmt}&amp;node=([0-9a-f]{8})`, 'g'))].map((m) => m[1]);

  it('f13-04: a host switched off for wgconf has no file card and no QR on the page; one switched off only for plain keeps both', async () => {
    const { sub, two } = await tunnelFleet();
    const before = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: browser });
    expect(qrTargets(before.body)).toEqual(expect.arrayContaining(['awg:awg-one', 'awg:awg-two', 'wg:awg-one']));

    // Off for plain only: the browser's own format must not decide the cards.
    await disableHosts(two, ['plain']);
    const plainOff = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: browser });
    expect(qrTargets(plainOff.body)).toContain('awg:awg-two');
    expect(fileRows(plainOff.body, 'wgconf').length).toBe(fileRows(before.body, 'wgconf').length);

    await disableHosts(two, ['wgconf']);
    const off = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: browser });
    expect(off.statusCode).toBe(200);
    expect(qrTargets(off.body)).not.toContain('awg:awg-two');
    expect(qrTargets(off.body)).toEqual(expect.arrayContaining(['awg:awg-one', 'wg:awg-one']));
    expect(fileRows(off.body, 'wgconf').length).toBeLessThan(fileRows(before.body, 'wgconf').length);
    expect(off.body).not.toContain('awg-two');
  });

  it('f13-03: `configUrls` on the tunnel endpoints only, each address serves a file, the rest of the answer is as before', async () => {
    const { sub } = await tunnelFleet();
    const res = await app.inject({ method: 'GET', url: `/sub/${sub}?format=json` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { endpoints: Ep[] };
    const awg = body.endpoints.filter((e) => e.protocol === 'amneziawg');
    const wg = body.endpoints.filter((e) => e.protocol === 'wireguard');
    expect(awg).toHaveLength(2);
    expect(wg).toHaveLength(1);
    for (const e of awg) {
      expect(Object.keys(e.configUrls!).sort()).toEqual(['amneziavpn', 'wgconf']);
      expect(e.configUrls!.wgconf!).toMatch(/\?format=wgconf&node=[0-9a-f]{8}$/);
    }
    // Plain WireGuard: the .conf only, named as the plain tunnel it is.
    expect(Object.keys(wg[0]!.configUrls!)).toEqual(['wgconf']);
    expect(wg[0]!.configUrls!.wgconf!).toContain('protocols=wireguard');
    // Not on anything else.
    for (const e of body.endpoints.filter((x) => x.protocol !== 'amneziawg' && x.protocol !== 'wireguard')) {
      expect(e).not.toHaveProperty('configUrls');
    }
    // Every address answers with a non-empty file, a node apiece.
    const confs = new Set<string>();
    for (const e of [...awg, ...wg]) {
      const url = new URL(e.configUrls!.wgconf!);
      const file = await app.inject({ method: 'GET', url: url.pathname + url.search });
      expect(file.statusCode, url.toString()).toBe(200);
      expect(file.body.length).toBeGreaterThan(0);
      confs.add(file.body);
    }
    expect(confs.size).toBe(3);
    const vpnUrl = new URL(awg[0]!.configUrls!.amneziavpn!);
    const vpn = await app.inject({ method: 'GET', url: vpnUrl.pathname + vpnUrl.search });
    expect(vpn.body.startsWith('vpn://')).toBe(true);
    // The rest of the answer is what it was without the addresses.
    const again = JSON.parse((await app.inject({ method: 'GET', url: `/sub/${sub}?format=json` })).body) as { endpoints: Ep[] };
    expect(withoutUrls(again.endpoints)).toEqual(withoutUrls(body.endpoints));
  });

  it('f13-03: a host switched off for wgconf does not name a file the route would not give', async () => {
    const { sub, two } = await tunnelFleet();
    await disableHosts(two, ['wgconf']);
    const body = JSON.parse((await app.inject({ method: 'GET', url: `/sub/${sub}?format=json` })).body) as {
      endpoints: Ep[];
    };
    const two2 = body.endpoints.filter((e) => e.protocol === 'amneziawg' && e.nodeName.includes('awg-two'));
    expect(two2[0]?.configUrls?.wgconf).toBeUndefined();
    expect(two2[0]?.configUrls?.amneziavpn).toBeDefined();
  });

  it('f13-13: a link with `node=` opens the page on that tunnel\'s .conf code; a name that is not held is the page without it', async () => {
    const { sub } = await tunnelFleet();
    const json = JSON.parse((await app.inject({ method: 'GET', url: `/sub/${sub}?format=json` })).body) as {
      endpoints: Ep[];
    };
    const second = json.endpoints.filter((e) => e.protocol === 'amneziawg')[1]!;
    const id = new URL(second.configUrls!.wgconf!).searchParams.get('node')!;
    const on = (html: string) => [...html.matchAll(/<figure class="qrf on" data-target="([^"]+)"( data-app="(\w+)")?/g)].map((m) => `${m[1]!.replace(/ · .*$/, '')}/${m[3]}`);

    const base = await app.inject({ method: 'GET', url: `/sub/${sub}`, headers: browser });
    expect(on(base.body)).toEqual(['awg:awg-one/vpn']);

    const pre = await app.inject({ method: 'GET', url: `/sub/${sub}?node=${id}`, headers: browser });
    expect(pre.statusCode).toBe(200);
    expect(on(pre.body)).toEqual([`awg:${second.nodeName.replace(/ · .*$/, '')}/conf`]);

    const unknown = await app.inject({ method: 'GET', url: `/sub/${sub}?node=nope`, headers: browser });
    expect(on(unknown.body)).toEqual(on(base.body));
    const noDevice = await app.inject({ method: 'GET', url: `/sub/${sub}?node=${id}&device=9`, headers: browser });
    expect(on(noDevice.body)).toEqual(on(base.body));
  });
});
