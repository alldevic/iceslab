import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthcheckResponse, NodeCores } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { pollNodeStatuses } from '../nodes/nodes.cron.js';
import { exitIpv6Moved } from './cascade.exit-ipv6-push.js';
import { getEntryNodeIdsByExitNode } from './cascade.service.js';

/**
 * 19.15: an exit's IPv6 answer reaches the entries of its cascades at once.
 * Seen by the entry's desired revision, which is what queuing a push bumps.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  await inboundSyncQueue.obliterate({ force: true });
  token = await registerAndLogin(app);
  stubNodeRoster();
  seq = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await inboundSyncQueue.close();
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

const XRAY_CONFIG = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

const cores = (egress: boolean): NodeCores =>
  ({
    cores: [],
    observedAt: '2026-11-28T00:00:00Z',
    ipv6: { stack: true, global: true, addresses: ['2001:db8::1'], egress },
  }) as unknown as NodeCores;

async function makeNode(name: string, withCores?: NodeCores): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name, address: `${name}-${seq}.test`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = JSON.parse(res.body).id as string;
  await prisma.node.update({
    where: { id },
    data: { status: 'online', ...(withCores ? { cores: withCores as never } : {}) },
  });
  return id;
}

async function bindXray(nodeId: string, name: string, port: number) {
  const p = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: { name, protocol: 'xray', config: XRAY_CONFIG },
  });
  expect(p.statusCode, p.body).toBe(201);
  const b = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth(),
    payload: { profileId: JSON.parse(p.body).id, nodeId, port },
  });
  expect(b.statusCode, b.body).toBe(201);
}

async function makeCascade(entry: string, exit: string, enabled = true): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/cascades',
    headers: auth(),
    payload: {
      name: `exit-v6-${seq}`,
      enabled,
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'vless' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

const revisionOf = async (id: string) =>
  (await prisma.node.findUniqueOrThrow({ where: { id }, select: { desiredRevision: true } })).desiredRevision;

/** An entry, its exit and a bystander, with the cascade between the first two. */
async function fixture(opts: { enabled?: boolean; exitEgress?: boolean } = {}) {
  const entry = await makeNode('ru-entry');
  const exit = await makeNode('nl-exit');
  const bystander = await makeNode('de-other');
  await bindXray(entry, 'reality-ru', 443);
  const cascade = await makeCascade(entry, exit, opts.enabled ?? true);
  // After the cascade: a node that reports engines is judged by them at save.
  await prisma.node.update({ where: { id: exit }, data: { cores: cores(opts.exitEgress ?? false) as never } });
  return { entry, exit, bystander, cascade };
}

describe('exitIpv6Moved', () => {
  it('compares the answer the entries are drawn by, not the facts', () => {
    expect(exitIpv6Moved({ cores: cores(false), ipv6Mode: 'auto' }, { cores: cores(true), ipv6Mode: 'auto' })).toBe(true);
    // The mode over a fact: `on` leaves by IPv6 either way.
    expect(exitIpv6Moved({ cores: cores(false), ipv6Mode: 'on' }, { cores: cores(true), ipv6Mode: 'on' })).toBe(false);
    expect(exitIpv6Moved({ cores: cores(true), ipv6Mode: 'auto' }, { cores: cores(true), ipv6Mode: 'off' })).toBe(true);
    expect(exitIpv6Moved({ cores: cores(false), ipv6Mode: 'auto' }, { cores: cores(false), ipv6Mode: 'off' })).toBe(false);
    expect(exitIpv6Moved({ cores: null, ipv6Mode: 'auto' }, { cores: cores(true), ipv6Mode: 'auto' })).toBe(true);
  });
});

describe('getEntryNodeIdsByExitNode', () => {
  it('names the entries of the enabled cascades the node exits, and nobody else', async () => {
    const { entry, exit, bystander } = await fixture();
    expect([...(await getEntryNodeIdsByExitNode([exit]))]).toEqual([entry]);
    expect((await getEntryNodeIdsByExitNode([bystander])).size).toBe(0);
    expect((await getEntryNodeIdsByExitNode([])).size).toBe(0);
  });

  it('skips a switched-off cascade', async () => {
    const { exit } = await fixture({ enabled: false });
    expect((await getEntryNodeIdsByExitNode([exit])).size).toBe(0);
  });
});

describe('a mode edit on the exit', () => {
  it('pushes the entries when the answer moves', async () => {
    const { entry, exit, bystander } = await fixture({ exitEgress: true });
    const before = { entry: await revisionOf(entry), other: await revisionOf(bystander) };
    const res = await app.inject({ method: 'PUT', url: `/api/nodes/${exit}`, headers: auth(), payload: { ipv6Mode: 'off' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await revisionOf(entry)).toBeGreaterThan(before.entry);
    expect(await revisionOf(bystander)).toBe(before.other);
  });

  it('pushes nobody when the effective answer stays', async () => {
    const { entry, exit } = await fixture({ exitEgress: false });
    const before = await revisionOf(entry);
    // auto over a failed egress is "no"; off is "no" too.
    const res = await app.inject({ method: 'PUT', url: `/api/nodes/${exit}`, headers: auth(), payload: { ipv6Mode: 'off' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await revisionOf(entry)).toBe(before);
  });

  it('pushes nobody for a switched-off cascade', async () => {
    const { entry, exit } = await fixture({ exitEgress: true, enabled: false });
    const before = await revisionOf(entry);
    await app.inject({ method: 'PUT', url: `/api/nodes/${exit}`, headers: auth(), payload: { ipv6Mode: 'off' } });
    expect(await revisionOf(entry)).toBe(before);
  });
});

describe('a new IPv6 fact of the exit, from the poll', () => {
  const polled = (egress: boolean): HealthcheckResponse =>
    ({
      status: 'ok',
      cores: [],
      ipv6: { stack: true, global: true, addresses: ['2001:db8::1'], egress },
    }) as unknown as HealthcheckResponse;

  async function poll(exit: string, answer: HealthcheckResponse) {
    const row = await prisma.node.findUniqueOrThrow({ where: { id: exit }, select: { address: true } });
    vi.spyOn(NodeTransport.prototype, 'healthcheck').mockImplementation(async function (this: unknown) {
      const addr = (this as { node: { address: string } }).node.address;
      if (addr === row.address) return answer;
      throw new Error(`no stub for ${addr}`);
    });
    vi.spyOn(NodeTransport.prototype, 'presentedCert').mockRejectedValue(new Error('no handshake in tests'));
    await pollNodeStatuses();
  }

  it('pushes the entries when the exit starts leaving by IPv6', async () => {
    const { entry, exit } = await fixture({ exitEgress: false });
    const before = await revisionOf(entry);
    await poll(exit, polled(true));
    expect(await revisionOf(entry)).toBeGreaterThan(before);
  });

  it('pushes nobody when the answer does not move (a write of the facts only)', async () => {
    const { entry, exit } = await fixture({ exitEgress: true });
    const before = await revisionOf(entry);
    // The same answer with another address list: a write, not a change.
    const same = polled(true);
    (same as unknown as { ipv6: { addresses: string[] } }).ipv6.addresses = ['2001:db8::2'];
    await poll(exit, same);
    expect(await revisionOf(entry)).toBe(before);
  });
});
