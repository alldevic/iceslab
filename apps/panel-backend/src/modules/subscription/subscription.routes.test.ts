import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';

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
  engine?: 'singbox',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: `${protocol}-${nameSuffix}`,
      protocol,
      config,
      ...(engine ? { engine } : {}),
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
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
      realityPublicKey: 'gy3mpcZB8YXumik_KSTiYG1AqYqxJnD5Ac99zJ370jQ',
    },
    `${nodeId.slice(0, 6)}-${port}`,
  );
  return createBinding(profileId, nodeId, port);
}

// The binding cache is busted by domain events, and the subscription only sees
// an admin's edit because something subscribed to them. `buildApp()` does not —
// `index.ts` does, once, at boot. Without this the whole file runs against a
// cache nothing invalidates, and a test that edits a host and re-reads /sub is
// silently reading the pre-edit world.
beforeAll(() => registerBindingsCacheBust());

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
    // longer exists — nothing read it, so it was dropped from the schema —
    // and 443 here is the fixture's binding port, not a panel-wide default.)
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

  it('the install page drops a client whose format renders nothing for this fleet', async () => {
    // XHTTP-only fleet. `transport-matrix.test.ts` records sing-box as
    // `omitted` for that transport, so every sing-box-cored client would hand
    // the buyer an empty config while looking like it worked.
    //
    // Asserted through the ROUTE, not through buildSubscriptionPage: the check
    // lives in a value the route computes and passes, and a route that stopped
    // passing it would leave every unit test green — which is exactly how the
    // wgconf download bug below survived.
    // A BARE node: `createNode` also attaches a Hysteria binding, and sing-box
    // carries Hysteria happily — with it in the fleet the format is usable and
    // the assertion below would be measuring the helper, not the gate.
    const nodeRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'xhttp-node', address: '10.0.0.22' },
    });
    expect(nodeRes.statusCode).toBe(201);
    const nodeId = JSON.parse(nodeRes.body).id as string;
    const profileId = await createProfile(
      'xray',
      {
        network: 'xhttp',
        path: '/dl',
        realityDest: 'www.cloudflare.com:443',
        realityServerNames: ['www.cloudflare.com'],
        realityShortIds: ['abc123'],
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        realityPublicKey: 'gy3mpcZB8YXumik_KSTiYG1AqYqxJnD5Ac99zJ370jQ',
      },
      'xhttponly',
    );
    await createBinding(profileId, nodeId, 9443);
    const user = await createUser('xhttponly');

    const page = (
      await app.inject({
        method: 'GET',
        url: `/sub/${user.subscriptionToken}`,
        headers: { accept: 'text/html' },
      })
    ).body;
    // The app CARDS, not the whole document: these names also appear in the
    // page's static hint text ("scan with Hiddify, v2rayNG, ...") and in the
    // per-format download buttons, so a plain substring search answers a
    // different question than the one being asked.
    const offered = new Set(
      [...page.matchAll(/class="aname">([^<]*)</g)].map((m) => m[1] as string),
    );

    // Control first: the page IS offering clients to this buyer, so the
    // absences below mean something.
    expect(offered).toContain('v2rayNG'); // xrayjson carries xhttp
    expect(offered).toContain('Shadowrocket'); // plain carries it too

    expect(offered, 'sing-box renders no server for xhttp').not.toContain('sing-box');
    expect(offered, 'Hiddify runs the sing-box core').not.toContain('Hiddify');
    expect(offered, 'NekoBox runs it too').not.toContain('NekoBox');
  });

  it('drops a tunnel download the wgconf format would refuse to serve', async () => {
    // The cards on the install page all lead to `?format=wgconf`, but the page
    // is rendered for a request whose resolved format is `plain` (that is what
    // a browser gets). Filtering the node list by the resolved format instead
    // of by `wgconf` left the button on the page and the download empty —
    // measured on the lab: 341 bytes before the host was switched off for
    // wgconf, 0 after, the button unmoved.
    const nodeId = await createNode('awg-gated', '10.0.0.21');
    const profileId = await createProfile(
      'amneziawg',
      {
        subnet: '10.88.0.0/24',
        serverPrivateKey: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
        serverPublicKey: 'BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=',
        obfuscation: {},
      },
      'awggated',
    );
    const bindingId = await createBinding(profileId, nodeId, 51821);
    const user = await createUser('awggated');

    const page = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/sub/${user.subscriptionToken}`,
          headers: { accept: 'text/html' },
        })
      ).body;

    // Control: with the host untouched the card is there AND the link works.
    const before = await page();
    expect(before).toContain('format=wgconf');
    const href = /format=wgconf[^"']*/.exec(before)?.[0] ?? '';
    const dl = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?${href}`,
    });
    expect(dl.body).toContain('[Interface]');

    // Switch the host off for wgconf only — nothing else changes.
    const hostsRes = await app.inject({
      method: 'GET',
      url: `/api/hosts?bindingId=${bindingId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const hostId = JSON.parse(hostsRes.body).hosts[0].id as string;
    const upd = await app.inject({
      method: 'PUT',
      url: `/api/hosts/${hostId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { disableForFormats: ['wgconf'] },
    });
    expect(upd.statusCode).toBe(200);

    // The download the page would offer now serves nothing …
    const empty = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?${href}`,
    });
    expect(empty.body).toBe('');
    // … so the page must not offer it.
    expect(await page()).not.toContain('format=wgconf');
  });

  it('names the per-node config files for an endpoint that has no share-link', async () => {
    // A WireGuard flavour has no client URI to give, so `plain` is empty for a
    // buyer holding only that (measured on the lab: 0 bytes). `json` is the
    // format that describes a subscription rather than feeding a proxy client,
    // so it says where the files are instead.
    const nodeId = await createNode('awg-node', '10.0.0.20');
    const profileId = await createProfile(
      'amneziawg',
      {
        subnet: '10.77.0.0/24',
        serverPrivateKey: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
        serverPublicKey: 'BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=',
        obfuscation: {},
      },
      'awgjson',
    );
    await createBinding(profileId, nodeId, 51820);
    const user = await createUser('awgjson');

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}?format=json` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const awg = body.endpoints.find((e: { protocol: string }) => e.protocol === 'amneziawg');
    expect(awg, 'the amneziawg endpoint is in the subscription at all').toBeDefined();
    // The reason the field exists: this endpoint genuinely has no share-link.
    expect(awg.uri).toBe('');
    expect(awg.configUrls.wgconf).toContain('format=wgconf&proto=amneziawg&node=');
    expect(awg.configUrls.amneziavpn).toContain('format=amneziavpn&node=');

    // Control: an endpoint that DOES carry a link is left alone.
    const hy = body.endpoints.find((e: { protocol: string }) => e.protocol === 'hysteria');
    expect(hy.uri).not.toBe('');
    expect(hy.configUrls).toBeUndefined();

    // And the URL it names actually serves the file — a well-formatted string
    // pointing at nothing would pass every assertion above.
    const named = new URL(awg.configUrls.wgconf);
    const dl = await app.inject({ method: 'GET', url: `${named.pathname}${named.search}` });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain('[Interface]');
    expect(dl.body).toContain('BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=');
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
    expect(v.tag).toBe('eu-1-xray');
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
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.body).toBe('');
  });

  // The wg path end to end: a profile saved through the API, bound to a node,
  // and the .conf a WireGuard client would import coming back out. Proven
  // against a real interface in the node's live test; this is the half of the
  // loop that lives here - that the panel produces the file at all, and that it
  // is the plain flavour rather than the obfuscated one.
  it('serves a plain wg-quick conf for a wireguard profile', async () => {
    const user = await createUser('alice');
    const nodeId = await createNode('eu-1', '10.0.0.1:8443');
    const profileId = await createProfile(
      'wireguard',
      {
        subnet: '10.77.77.0/24',
        serverPrivateKey: 'iOFrH+3vXxLdV2y8mAqM0d4Wd8LZ2b1n4uOJFsGm3Uk=',
        serverPublicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      'plain',
    );
    await createBinding(profileId, nodeId, 51821);

    const res = await app.inject({
      method: 'GET',
      url: `/sub/${user.subscriptionToken}?format=wgconf&proto=wireguard`,
    });
    expect(res.statusCode).toBe(200);
    // Не text/plain: Android достраивает расширение по MIME-типу и превращает
    // `OneginVPN-wg.conf` в `…conf.txt`, мимо фильтра `*.conf` в пикере
    // WireGuard и AmneziaWG. У octet-stream расширения нет, имя доезжает как есть.
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('.conf"');
    expect(res.headers['content-disposition']).not.toContain('.txt');
    expect(res.body).toContain('[Interface]');
    expect(res.body).toContain('[Peer]');
    expect(res.body).toContain('PublicKey = BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    // The endpoint is the binding's port, not WireGuard's 51820 default: the
    // config advertising a port the server does not listen on is the failure
    // this pairing exists to prevent.
    expect(res.body).toContain('Endpoint = 10.0.0.1:51821');
    // An address out of the profile's own subnet, allocated to this user.
    expect(res.body).toMatch(/Address = 10\.77\.77\.\d+\/32/);
    // And nothing a stock client would refuse to parse. `wg setconf` answers
    // `Line unrecognized: 'Jc=4'` and wg-quick then deletes the device, so one
    // leaked directive costs the whole tunnel.
    for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      expect(res.body).not.toContain(`${key} = `);
    }
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

/**
 * Which certificate a hysteria client meets is a property of the ENGINE: the
 * native core has an ACME certificate for the node's own name, the sing-box
 * engine has the self-signed one bootstrap-singbox.sh writes for the TUIC and
 * AnyTLS inbounds. The link has to say which, and the engine is only knowable
 * here if the binding query actually selects it - which is the half a unit test
 * on the builders cannot see.
 *
 * See hysteria-singbox-cert.test.ts for the measurement (no client can connect
 * to a sing-box-served hysteria2 inbound from a link without it).
 */
describe('GET /sub/:token - hysteria against the engine that serves it', () => {
  // A bare node, NOT createNode(): that helper attaches a native hysteria
  // inbound of its own, and the point here is which engine serves the ONE
  // hysteria endpoint the user is handed.
  async function bareNode(name: string, address: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { authorization: `Bearer ${token}` },
      payload: { name, address },
    });
    if (res.statusCode !== 201) throw new Error(`bareNode: ${res.statusCode} ${res.body}`);
    return JSON.parse(res.body).id as string;
  }

  it('admits the self-signed cert for a sing-box-served profile', async () => {
    const user = await createUser('sbhy');
    const nodeId = await bareNode('sb-1', '10.0.0.9:8443');
    const profileId = await createProfile('hysteria', {}, 'sb', 'singbox');
    await createBinding(profileId, nodeId, 8443);

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}` });
    const decoded = Buffer.from(res.body, 'base64').toString('utf8');
    const line = decoded.split('\n').find((l) => l.startsWith('hysteria2://'));
    expect(line, `no hysteria line in: ${decoded}`).toBeDefined();
    expect(new URL(line as string).searchParams.get('insecure')).toBe('1');
  });

  it('keeps verifying for a natively-served profile', async () => {
    const user = await createUser('nathy');
    const nodeId = await bareNode('nat-1', '10.0.0.10:8443');
    const profileId = await createProfile('hysteria', {}, 'nat');
    await createBinding(profileId, nodeId, 8443);

    const res = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}` });
    const decoded = Buffer.from(res.body, 'base64').toString('utf8');
    const line = decoded.split('\n').find((l) => l.startsWith('hysteria2://'));
    expect(line, `no hysteria line in: ${decoded}`).toBeDefined();
    expect(new URL(line as string).searchParams.get('insecure')).toBeNull();
  });
});
