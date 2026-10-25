import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';
import { rotateHysteriaTls } from '../nodes/hysteria-tls.js';
import { ensureAwg3Geometry } from '../nodes/awg3-geometry.js';
import { updateProfile } from '../profiles/profiles.service.js';
import { BINDING_LINK_FIELDS, HOST_LINK_FIELDS, NODE_LINK_FIELDS, PROFILE_LINK_FIELDS } from './hosts.freshness.js';

/**
 * A-122: "who still holds the old link" reads a stamp that moves only when a
 * value going into the link really changed, in each of the four rows a link
 * is made of. On the real database, field by field.
 */

let app: FastifyInstance;
let token: string;

beforeAll(() => registerBindingsCacheBust());

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
async function call(method: 'POST' | 'PUT' | 'GET', url: string, payload?: Record<string, unknown>) {
  const res = await app.inject({ method, url, headers: auth(), ...(payload ? { payload } : {}) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
}

const OLD = new Date('2020-01-01T00:00:00Z');

interface World { nodeId: string; profileId: string; bindingId: string; hostId: string; sub: string }

/** A node by IP (so hysteria would pin), a Shadowsocks profile on it, its
 *  host, an active subscriber and a disabled one. */
async function world(): Promise<World> {
  const node = await call('POST', '/api/nodes', { name: 'lc-node', address: '203.0.113.7', protocol: 'xray' });
  const profile = await call('POST', '/api/profiles', { name: 'lc-ss', protocol: 'shadowsocks', config: { method: 'aes-256-gcm' } });
  const binding = await call('POST', '/api/bindings', { profileId: profile.id, nodeId: node.id, port: 8388 });
  const host = await prisma.host.findFirstOrThrow({ where: { bindingId: binding.id as string }, select: { id: true } });
  const user = await call('POST', '/api/users', { username: 'lc-active' });
  await call('POST', '/api/users', { username: 'lc-off' }).then((u) => prisma.user.update({ where: { id: u.id as string }, data: { status: 'disabled' } }));
  const sub = (await prisma.user.findUniqueOrThrow({ where: { id: user.id as string }, select: { subscriptionToken: true } })).subscriptionToken;
  return { nodeId: node.id as string, profileId: profile.id as string, bindingId: binding.id as string, hostId: host.id, sub };
}

/** All four stamps back to a known old moment. */
async function age(): Promise<void> {
  for (const t of ['hosts', 'profile_node_bindings', 'profiles', 'nodes']) {
    await prisma.$executeRawUnsafe(`UPDATE ${t} SET link_changed_at = $1`, OLD);
  }
}

const stampOf = {
  host: async (id: string) => (await prisma.host.findUniqueOrThrow({ where: { id } })).linkChangedAt,
  binding: async (id: string) => (await prisma.profileNodeBinding.findUniqueOrThrow({ where: { id } })).linkChangedAt,
  profile: async (id: string) => (await prisma.profile.findUniqueOrThrow({ where: { id } })).linkChangedAt,
  node: async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id } })).linkChangedAt,
};
const moved = (d: Date) => d.getTime() > OLD.getTime();

describe('the host stamp', () => {
  const CHANGES: Record<(typeof HOST_LINK_FIELDS)[number], unknown> = {
    remark: 'Renamed', enabled: false, addressOverride: 'other.test', portOverride: 9999,
    sniOverride: 'sni.test', hostHeaderOverride: 'h.test', pathOverride: '/p', fingerprintOverride: 'firefox',
    alpn: ['h2'], allowInsecure: true, securityLayer: 'tls', disableForFormats: ['plain'],
    serverDescription: 'Fast lane', isHidden: true,
  };

  it('every field that reaches the client moves it', async () => {
    const w = await world();
    for (const field of HOST_LINK_FIELDS) {
      await age();
      await call('PUT', `/api/hosts/${w.hostId}`, { [field]: CHANGES[field] });
      expect(moved(await stampOf.host(w.hostId)), field).toBe(true);
    }
  });

  it('priority, a reorder and a save of the same values do not', async () => {
    const w = await world();
    await age();
    await call('PUT', `/api/hosts/${w.hostId}`, { priority: 7 });
    await call('PUT', '/api/hosts/reorder', { hostIds: [w.hostId] });
    const h = await prisma.host.findUniqueOrThrow({ where: { id: w.hostId } });
    await call('PUT', `/api/hosts/${w.hostId}`, { remark: h.remark, alpn: h.alpn, enabled: h.enabled, disableForFormats: h.disableForFormats });
    expect(await stampOf.host(w.hostId)).toEqual(OLD);
  });
});

describe('the binding stamp', () => {
  const CHANGES: Partial<Record<(typeof BINDING_LINK_FIELDS)[number], unknown>> = {
    port: 8399, publicHost: 'pub.test', publicPort: 9443, overrides: { password: 'x' }, enabled: false,
  };

  it('every field the panel edits moves it; the same values do not', async () => {
    const w = await world();
    for (const [field, value] of Object.entries(CHANGES)) {
      await age();
      await call('PUT', `/api/bindings/${w.bindingId}`, { [field]: value });
      expect(moved(await stampOf.binding(w.bindingId)), field).toBe(true);
    }
    await age();
    const b = await prisma.profileNodeBinding.findUniqueOrThrow({ where: { id: w.bindingId } });
    await call('PUT', `/api/bindings/${w.bindingId}`, { port: b.port, enabled: b.enabled });
    expect(await stampOf.binding(w.bindingId)).toEqual(OLD);
  });
});

describe('the profile stamp', () => {
  it('config, engine and enabled move it; name and description do not', async () => {
    const w = await world();
    await age();
    await call('PUT', `/api/profiles/${w.profileId}`, { name: 'lc-renamed', description: 'notes' });
    expect(await stampOf.profile(w.profileId)).toEqual(OLD);

    await call('PUT', `/api/profiles/${w.profileId}`, { enabled: false });
    expect(moved(await stampOf.profile(w.profileId)), 'enabled').toBe(true);
    await age();
    await call('PUT', `/api/profiles/${w.profileId}`, { config: { method: 'chacha20-ietf-poly1305' } });
    expect(moved(await stampOf.profile(w.profileId)), 'config').toBe(true);

    // engine on a profile deployed nowhere: the node gates do not apply.
    const bare = await call('POST', '/api/profiles', { name: 'lc-bare', protocol: 'shadowsocks', config: { method: 'aes-256-gcm' } });
    await age();
    await updateProfile(bare.id as string, { engine: 'singbox' });
    expect(moved(await stampOf.profile(bare.id as string)), 'engine').toBe(true);
    expect(PROFILE_LINK_FIELDS).toEqual(['config', 'engine', 'awgProtocol', 'enabled']);
  });

  it('awgProtocol moves it', async () => {
    const awg = await prisma.profile.create({ data: { name: 'lc-awg', protocol: 'amneziawg', config: { subnet: '10.66.66.0/24' } } });
    await age();
    await updateProfile(awg.id, { awgProtocol: 3 });
    expect(moved(await stampOf.profile(awg.id)), 'awgProtocol').toBe(true);
  });

  it('a binding\'s transport moved by its profile\'s config moves the binding\'s stamp', async () => {
    const node = await prisma.node.create({
      data: { name: 'lc-kcp', address: 'kcp.test', protocol: 'xray', heartbeatSecret: Buffer.alloc(32) },
      select: { id: true },
    });
    const config = { security: 'none', subprotocol: 'vless', network: 'raw' };
    const xr = await prisma.profile.create({ data: { name: 'lc-raw', protocol: 'xray', config } });
    const b = await prisma.profileNodeBinding.create({ data: { nodeId: node.id, profileId: xr.id, port: 9000, transport: 'tcp' } });
    await age();
    await updateProfile(xr.id, { config: { ...config, network: 'kcp' } } as never);
    const after = await prisma.profileNodeBinding.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.transport).not.toBe('tcp');
    expect(moved(after.linkChangedAt), 'transport').toBe(true);
  });
});

describe('the node stamp', () => {
  it('address and domain move it; name and country do not; the hysteria pin and the 3.1 geometry move it where they are written', async () => {
    const w = await world();
    await age();
    await call('PUT', `/api/nodes/${w.nodeId}`, { name: 'lc-node-2', countryCode: 'NL' });
    expect(await stampOf.node(w.nodeId)).toEqual(OLD);
    for (const [field, value] of [['address', '203.0.113.8'], ['domain', 'self.example.com']] as const) {
      await age();
      await call('PUT', `/api/nodes/${w.nodeId}`, { [field]: value });
      expect(moved(await stampOf.node(w.nodeId)), field).toBe(true);
    }
    expect(NODE_LINK_FIELDS).toEqual(['address', 'domain']);

    await age();
    await rotateHysteriaTls(w.nodeId);
    expect(moved(await stampOf.node(w.nodeId)), 'hysteria pin').toBe(true);

    await age();
    await ensureAwg3Geometry(w.nodeId);
    expect(moved(await stampOf.node(w.nodeId)), 'awg 3.1 geometry, minted').toBe(true);
    await age();
    await ensureAwg3Geometry(w.nodeId);
    expect(await stampOf.node(w.nodeId), 'awg 3.1 geometry, already there').toEqual(OLD);
  });
});

describe('the card', () => {
  async function freshness(hostId: string) {
    return (await call('GET', `/api/hosts/${hostId}/freshness`)) as { stale: number; current: number; total: number; configChangedAt: string };
  }
  async function fetchSub(sub: string) {
    // Past the stamps the edits leave, to the millisecond (the card compares with `>`).
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({ method: 'GET', url: `/sub/${sub}?format=plain` });
  }

  it('counts only active users, and reads stale only after an edit that reaches the link', async () => {
    const w = await world();
    await fetchSub(w.sub);
    expect(await freshness(w.hostId)).toMatchObject({ total: 1, stale: 0, current: 1 });

    await call('PUT', '/api/hosts/reorder', { hostIds: [w.hostId] });
    await call('PUT', `/api/profiles/${w.profileId}`, { name: 'lc-renamed' });
    await call('PUT', `/api/nodes/${w.nodeId}`, { name: 'lc-node-2' });
    expect((await freshness(w.hostId)).stale, 'reorder, renames').toBe(0);

    await call('PUT', `/api/nodes/${w.nodeId}`, { address: '203.0.113.9' });
    expect((await freshness(w.hostId)).stale, 'node address').toBe(1);

    await fetchSub(w.sub);
    expect((await freshness(w.hostId)).stale).toBe(0);
    await rotateHysteriaTls(w.nodeId);
    expect((await freshness(w.hostId)).stale, 'hysteria pin rotated').toBe(1);
  });

  it('configChangedAt in the host DTO is the latest of the four stamps, as the card says', async () => {
    const w = await world();
    await age();
    const at = new Date('2026-03-04T05:06:07Z');
    await prisma.$executeRaw`UPDATE nodes SET link_changed_at = ${at} WHERE id = ${w.nodeId}::uuid`;
    const one = await call('GET', `/api/hosts/${w.hostId}`);
    const list = (await call('GET', '/api/hosts')).hosts as { id: string; configChangedAt: string }[];
    expect(one.configChangedAt).toBe(at.toISOString());
    expect(list.find((h) => h.id === w.hostId)!.configChangedAt).toBe(at.toISOString());
    expect((await freshness(w.hostId)).configChangedAt).toBe(at.toISOString());
  });
});
