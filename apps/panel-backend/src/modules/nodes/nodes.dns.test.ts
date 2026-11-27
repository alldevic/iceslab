import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { applyInboundsRequestForNode } from '../inbounds/inbounds.queue.js';

/**
 * Э3 F on the panel side: the NODE names the resolver its users get.
 *
 * It shipped on the profile first and moved here, because every core we render
 * to keeps one dns section per PROCESS and the process is one per node. On the
 * profile it needed a conflict check at every save and a refusal on the node;
 * both are gone, and the tests that covered them are gone with them.
 *
 * What can still go wrong quietly is pinned below: the setting can be dropped on
 * the way (Zod strips what the schema does not declare, which is exactly how
 * realityMode was lost once), and a changed resolver can fail to reach the node
 * at all, which looks like a saved setting that simply does nothing.
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

const YANDEX = {
  servers: [
    {
      address: '77.88.8.8',
      domains: ['geosite:category-ru'],
      expectIps: ['geoip:ru'],
      skipFallback: true,
    },
    { address: '8.8.8.8' },
  ],
  queryStrategy: 'UseIPv4',
};

const CLOUDFLARE = { servers: [{ address: '1.1.1.1' }] };

/** What the schema stores: it fills the optional halves of every server, so a
 *  literal written the short way is not what comes back. Comparing against the
 *  short form would pass today and break the moment a default is added. */
function stored(dns: { servers: Record<string, unknown>[]; queryStrategy?: string }) {
  return {
    ...dns,
    servers: dns.servers.map((s) => ({
      domains: [],
      expectIps: [],
      skipFallback: false,
      ...s,
    })),
  };
}

async function makeNode(dns?: unknown, expected = 201) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: {
      name: `dns-node-${seq}`,
      address: `dns-${seq}.test`,
      protocol: 'xray',
      ...(dns ? { dns } : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(expected);
  return JSON.parse(res.body);
}

async function editNode(id: string, payload: unknown, expected = 200) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/nodes/${id}`,
    headers: auth(),
    payload: payload as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(expected);
  return JSON.parse(res.body);
}

describe('a node names its resolver', () => {
  it('keeps the whole setting through the schema', async () => {
    // Zod strips undeclared keys, and that is how realityMode was silently lost
    // once: the wire, the node and the subscription all read it, and only the
    // schema did not know about it.
    const node = await makeNode(YANDEX);
    expect(node.dns).toEqual(stored(YANDEX));
  });

  it('defaults to naming nobody, which is what every node does today', async () => {
    const node = await makeNode();
    expect(node.dns).toBeNull();
  });

  it('refuses a resolver with no servers rather than storing an empty section', async () => {
    // xray refuses such a config, and it refuses configs WHOLE: it would take
    // the node's inbounds down with it.
    await makeNode({ servers: [] }, 400);
  });

  it('can be changed and cleared', async () => {
    const node = await makeNode(YANDEX);
    const changed = await editNode(node.id, { dns: CLOUDFLARE });
    expect(changed.dns).toEqual(stored(CLOUDFLARE));
    const cleared = await editNode(node.id, { dns: null });
    expect(cleared.dns).toBeNull();
  });
});

describe('the push tells the node about it', () => {
  it('carries the resolver next to the inbounds, not inside one', async () => {
    const node = await makeNode(YANDEX);
    const req = await applyInboundsRequestForNode(node.id);
    expect(req?.dns).toEqual(stored(YANDEX));
  });

  it('carries no dns key at all when the node named nobody', async () => {
    // Absent, not an empty section: that is what makes the whole feature inert
    // on every node nobody has set it on.
    const node = await makeNode();
    const req = await applyInboundsRequestForNode(node.id);
    expect(req).not.toBeNull();
    expect(req && 'dns' in req).toBe(false);
  });

  it('drops the key again once the resolver is cleared', async () => {
    const node = await makeNode(YANDEX);
    await editNode(node.id, { dns: null });
    const req = await applyInboundsRequestForNode(node.id);
    expect(req && 'dns' in req).toBe(false);
  });
});

describe('19.10: the rules carried from presets ride in the same dns', () => {
  const CARRIED = [{ presetId: null, rules: [{ match: ['example.com'], server: '10.99.0.1' }] }];

  it('puts the carried servers after the manual ones and leaves the manual setting as it was', async () => {
    const node = await makeNode(YANDEX);
    await prisma.node.update({ where: { id: node.id }, data: { presetDnsRules: CARRIED } });
    const req = await applyInboundsRequestForNode(node.id);
    expect(req?.dns).toEqual({
      ...stored(YANDEX),
      servers: [...stored(YANDEX).servers, { address: '10.99.0.1', domains: ['domain:example.com'], skipFallback: true }],
    });
    expect((await prisma.node.findUniqueOrThrow({ where: { id: node.id } })).dns).toEqual(stored(YANDEX));
  });

  it('a node with only carried rules gets them after the default resolvers, one with none the request it always got', async () => {
    const carried = await makeNode();
    await prisma.node.update({ where: { id: carried.id }, data: { presetDnsRules: CARRIED } });
    expect((await applyInboundsRequestForNode(carried.id))?.dns).toEqual({
      servers: [{ address: '1.1.1.1' }, { address: '8.8.8.8' }, { address: 'localhost' }, { address: '10.99.0.1', domains: ['domain:example.com'], skipFallback: true }],
      queryStrategy: 'UseIPv4',
    });
    const plain = await makeNode(YANDEX);
    expect((await applyInboundsRequestForNode(plain.id))?.dns).toEqual(stored(YANDEX));
    const bare = await makeNode();
    const req = await applyInboundsRequestForNode(bare.id);
    expect(req && 'dns' in req).toBe(false);
  });

  it('the default section takes the node\'s IPv6 answer as its queryStrategy, a manual dns keeps its own', async () => {
    const v6 = { observedAt: new Date().toISOString(), cores: [], ipv6: { stack: true, global: true, addresses: ['2001:db8::1'], egress: true } };
    const node = await makeNode();
    await prisma.node.update({ where: { id: node.id }, data: { presetDnsRules: CARRIED, cores: v6 as never } });
    expect((await applyInboundsRequestForNode(node.id))?.dns?.queryStrategy).toBe('UseIP');
    await prisma.node.update({ where: { id: node.id }, data: { ipv6Mode: 'off' } });
    expect((await applyInboundsRequestForNode(node.id))?.dns?.queryStrategy).toBe('UseIPv4');
    const manual = await makeNode({ servers: [{ address: '9.9.9.9' }] });
    await prisma.node.update({ where: { id: manual.id }, data: { presetDnsRules: CARRIED, cores: v6 as never } });
    expect((await applyInboundsRequestForNode(manual.id))?.dns?.queryStrategy).toBeUndefined();
  });

  it('a rule the core does not run is not sent', async () => {
    const node = await makeNode();
    await prisma.node.update({ where: { id: node.id }, data: { presetDnsRules: [{ presetId: null, rules: [{ match: ['x.com'], server: 'tls://dns.example' }] }] } });
    const req = await applyInboundsRequestForNode(node.id);
    expect(req && 'dns' in req).toBe(false);
  });
});

describe('19.12: the node answer shows what it carries, apart from the manual dns', () => {
  const get = async (id: string) =>
    JSON.parse((await app.inject({ method: 'GET', url: `/api/nodes/${id}`, headers: auth() })).body) as {
      dns: unknown;
      carriedDns: { presetId: string | null; rules: { match: string[]; server: string; overridden: string[] }[] }[];
    };

  it('is empty for a node nothing reaches', async () => {
    expect((await get((await makeNode(YANDEX)).id)).carriedDns).toEqual([]);
  });

  it('lists each source with its rules and the names the node\'s own dns takes, and leaves dns alone', async () => {
    const node = await makeNode({ servers: [{ address: '9.9.9.9', domains: ['domain:example.com'] }] });
    const preset = await prisma.routingPreset.create({ data: { name: 'Alpha' }, select: { id: true } });
    await prisma.node.update({
      where: { id: node.id },
      data: {
        presetDnsRules: [
          { presetId: preset.id, rules: [{ match: ['example.com', 'other.org'], server: '10.99.0.1' }, { match: ['x.org'], server: '10.99.0.2' }] },
          { presetId: null, rules: [{ match: ['panel.org'], server: '10.99.0.3' }] },
        ],
      },
    });
    const dto = await get(node.id);
    expect(dto.carriedDns).toEqual([
      {
        presetId: preset.id,
        rules: [
          { match: ['example.com', 'other.org'], server: '10.99.0.1', overridden: ['example.com'] },
          { match: ['x.org'], server: '10.99.0.2', overridden: [] },
        ],
      },
      { presetId: null, rules: [{ match: ['panel.org'], server: '10.99.0.3', overridden: [] }] },
    ]);
    expect(dto.dns).toEqual(stored({ servers: [{ address: '9.9.9.9', domains: ['domain:example.com'] }] }));
  });
});
