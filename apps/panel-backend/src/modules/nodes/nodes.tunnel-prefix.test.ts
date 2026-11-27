import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { CreateNodeSchema, UpdateNodeSchema } from './nodes.schemas.js';
import { assertTunnelPrefixFree, TunnelPrefixOverlapError } from './node-core-gate.js';

/**
 * 18.11: the real IPv6 prefix routed to a node, for the WireGuard-family tunnel.
 * A column, a field of the node API, a schema that takes only a global prefix of
 * /32 to /64, and a refusal of two nodes on one range.
 */
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  stubNodeRoster();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function stored(name = 'pfx-node'): Promise<string> {
  const n = await prisma.node.create({
    data: { name, address: `${name}.example.com`, protocol: 'xray', status: 'online', heartbeatSecret: randomBytes(32) },
    select: { id: true },
  });
  return n.id;
}

const put = (id: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/nodes/${id}`, headers: auth(), payload });
const get = async (id: string) =>
  JSON.parse((await app.inject({ method: 'GET', url: `/api/nodes/${id}`, headers: auth() })).body) as { tunnelIpv6Prefix: string | null };

describe('the schemas', () => {
  const body = { name: 'a', address: 'a.example.com' };
  const refused = (prefix: string) =>
    !UpdateNodeSchema.safeParse({ tunnelIpv6Prefix: prefix }).success && !CreateNodeSchema.safeParse({ ...body, tunnelIpv6Prefix: prefix }).success;

  it('takes a global prefix of /32 to /64 and writes it in one spelling', () => {
    expect(UpdateNodeSchema.parse({ tunnelIpv6Prefix: '2001:0DB8:0077::/48' }).tunnelIpv6Prefix).toBe('2001:db8:77::/48');
    expect(UpdateNodeSchema.parse({ tunnelIpv6Prefix: ' 2001:db8:77:1::/64 ' }).tunnelIpv6Prefix).toBe('2001:db8:77:1::/64');
    expect(CreateNodeSchema.parse({ ...body, tunnelIpv6Prefix: '2a01:4f8::/32' }).tunnelIpv6Prefix).toBe('2a01:4f8::/32');
    expect(UpdateNodeSchema.parse({ tunnelIpv6Prefix: null }).tunnelIpv6Prefix).toBeNull();
    expect(UpdateNodeSchema.parse({}).tunnelIpv6Prefix).toBeUndefined();
  });

  it.each([
    ['fd12:3456:789a:1::/64', /ULA/],
    ['fe80::/64', /link-local/],
    ['2001:db8:77:1::/65', /\/64 or shorter/],
    ['2001:db8:77:1::1/128', /\/64 or shorter/],
    ['2001:db8::/16', /\/32 or longer/],
    ['ff02::/32', /global unicast/],
    ['2001:db8:77:1::5/64', /bits set/],
    ['10.0.0.0/24', /IPv6 prefix/],
    ['not a prefix', /IPv6 prefix/],
  ])('refuses %s', (prefix, why) => {
    expect(refused(prefix)).toBe(true);
    const r = UpdateNodeSchema.safeParse({ tunnelIpv6Prefix: prefix });
    expect(JSON.stringify(r.error?.issues)).toMatch(why);
  });
});

describe('the field on the node API', () => {
  it('a node nobody set reads as null', async () => {
    expect((await get(await stored())).tunnelIpv6Prefix).toBeNull();
  });

  it('is set by an edit, read back, kept by an edit without it, and taken off by null', async () => {
    const id = await stored();
    const res = await put(id, { tunnelIpv6Prefix: '2001:DB8:77:0::/48' });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).tunnelIpv6Prefix).toBe('2001:db8:77::/48');
    await put(id, { name: 'pfx-renamed' });
    expect((await get(id)).tunnelIpv6Prefix).toBe('2001:db8:77::/48');
    expect((await put(id, { tunnelIpv6Prefix: null })).statusCode).toBe(200);
    expect((await get(id)).tunnelIpv6Prefix).toBeNull();
  });

  it('a ULA, a link-local or a /65 is a 400 and changes nothing', async () => {
    const id = await stored();
    await put(id, { tunnelIpv6Prefix: '2001:db8:77::/48' });
    for (const bad of ['fd12:3456:789a:1::/64', 'fe80::/64', '2001:db8:77:1::/65']) {
      expect((await put(id, { tunnelIpv6Prefix: bad })).statusCode, bad).toBe(400);
    }
    expect((await get(id)).tunnelIpv6Prefix).toBe('2001:db8:77::/48');
  });

  it('create takes it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'created', address: 'created.example.com', tunnelIpv6Prefix: '2001:db8:aa::/48' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).tunnelIpv6Prefix).toBe('2001:db8:aa::/48');
  });
});

describe('two nodes on one range', () => {
  it('a prefix another node has, or holds, or sits in, is a 409 with the node named', async () => {
    const a = await stored('node-a');
    const b = await stored('node-b');
    expect((await put(a, { tunnelIpv6Prefix: '2001:db8:77::/48' })).statusCode).toBe(200);
    for (const clash of ['2001:db8:77::/48', '2001:db8:77:5::/64', '2001:db8::/32']) {
      const res = await put(b, { tunnelIpv6Prefix: clash });
      expect(res.statusCode, clash).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'TUNNEL_PREFIX_OVERLAP', otherKind: 'node', otherName: 'node-a' });
      expect((await get(b)).tunnelIpv6Prefix).toBeNull();
    }
    expect((await put(b, { tunnelIpv6Prefix: '2001:db8:78::/48' })).statusCode).toBe(200);
    // The node's own prefix is not a clash with itself.
    expect((await put(a, { tunnelIpv6Prefix: '2001:db8:77::/56' })).statusCode).toBe(200);
  });

  it('create is held to the same rule', async () => {
    const a = await stored('node-a');
    await put(a, { tunnelIpv6Prefix: '2001:db8:77::/48' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: auth(),
      payload: { name: 'clash', address: 'clash.example.com', tunnelIpv6Prefix: '2001:db8:77:1::/64' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error).toBe('TUNNEL_PREFIX_OVERLAP');
  });

  it('a soft-deleted node holds no range', async () => {
    const a = await stored('node-a');
    await put(a, { tunnelIpv6Prefix: '2001:db8:77::/48' });
    await prisma.node.update({ where: { id: a }, data: { deletedAt: new Date() } });
    await expect(assertTunnelPrefixFree(null, '2001:db8:77::/48')).resolves.toBeUndefined();
  });

  it('a profile whose subnet6 lies in the range is refused (written around the schemas: they hold it to a ULA)', async () => {
    await prisma.profile.create({
      data: {
        name: 'odd',
        protocol: 'wireguard',
        config: { subnet: '10.77.77.0/24', subnet6: '2001:db8:77:9::/64' },
      } as never,
    });
    await expect(assertTunnelPrefixFree(null, '2001:db8:77::/48')).rejects.toBeInstanceOf(TunnelPrefixOverlapError);
    await expect(assertTunnelPrefixFree(null, '2001:db8:78::/48')).resolves.toBeUndefined();
  });
});

describe('a change reaches the node', () => {
  it('an edit that changes it emits node.updated (which queues the push); the same value does not', async () => {
    const id = await stored();
    const emit = vi.spyOn(eventBus, 'emit');
    await put(id, { tunnelIpv6Prefix: '2001:db8:77::/48' });
    expect(emit).toHaveBeenCalledWith('node.updated', { nodeId: id, nodeName: 'pfx-node' });
    emit.mockClear();
    await put(id, { tunnelIpv6Prefix: '2001:DB8:77::/48' });
    expect(emit).not.toHaveBeenCalledWith('node.updated', expect.anything());
    await put(id, { tunnelIpv6Prefix: null });
    expect(emit).toHaveBeenCalledWith('node.updated', { nodeId: id, nodeName: 'pfx-node' });
  });
});
