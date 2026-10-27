import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerInboundEventHandlers } from '../inbounds/inbounds.events.js';

/**
 * "Saved, but not applied yet" for a node.
 *
 * Until now only a cascade could tell a landed push from one in flight: the
 * comparison lived inside getCascadeStatus, so a node card had nothing to draw
 * the state from and a save looked identical whether it had reached the machine
 * or not.
 *
 * The hard half is not the comparison, it is what it compares AGAINST. A node
 * does not own its inbound set: editing a profile that six nodes share changes
 * the config of all six without touching one node row, so `node.updatedAt`
 * alone would call a pending push applied.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

// A-162: what marks a node pending is the push being ASKED for, which the
// event handlers do (index.ts registers them; buildApp does not). Subscribed
// once: the bus has no unsubscribe.
beforeAll(() => registerInboundEventHandlers());

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

async function makeNode(): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: `sync-${seq}`, address: `sync-${seq}.test`, protocol: 'xray' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function makeProfile(): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: {
      name: `sync-profile-${seq}`,
      protocol: 'xray',
      config: {
        security: 'reality',
        realityDest: 'www.microsoft.com:443',
        realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43),
        realityPublicKey: 'p'.repeat(43),
        realityShortIds: ['0123abcd'],
        network: 'raw',
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function bind(profileId: string, nodeId: string, port: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth(),
    payload: { profileId, nodeId, port },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

/** The node's revision once the event handlers of the last request have run:
 *  they bump it asynchronously, after the response. */
async function settledRevision(nodeId: string): Promise<bigint> {
  // Unchanged across three looks 100 ms apart: under a full run a handler can
  // land well after a single short pause.
  let last = -1n;
  let still = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const now = (await prisma.node.findUniqueOrThrow({ where: { id: nodeId } })).desiredRevision;
    still = now === last ? still + 1 : 0;
    if (still >= 2) return now;
    last = now;
  }
}

/**
 * The agent acknowledging a push, which is the only thing that stamps this:
 * as the worker does it (A-162), the revision the push was built for and the
 * time it was built.
 */
async function acknowledge(nodeId: string, when?: Date): Promise<void> {
  const rev = await settledRevision(nodeId);
  await prisma.node.update({
    where: { id: nodeId },
    data: { lastInboundSyncAt: when ?? new Date(), appliedRevision: rev },
  });
}

async function syncStatus(nodeId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/sync-status`,
    headers: auth(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as {
    lastInboundSyncAt: string | null;
    configChangedAt: string;
    applied: boolean;
    online: boolean;
  };
}

describe('node sync status', () => {
  it('a node that has never taken a config is not applied', async () => {
    const nodeId = await makeNode();
    const s = await syncStatus(nodeId);
    expect(s.lastInboundSyncAt).toBeNull();
    expect(s.applied).toBe(false);
  });

  it('becomes applied once the agent acknowledges a push after the change', async () => {
    const nodeId = await makeNode();
    await acknowledge(nodeId);
    const s = await syncStatus(nodeId);
    expect(s.applied).toBe(true);
    expect(new Date(s.lastInboundSyncAt!) > new Date(s.configChangedAt)).toBe(true);
  });

  it('goes back to pending when a BINDING changes after the acknowledgement', async () => {
    const nodeId = await makeNode();
    const profileId = await makeProfile();
    const bindingId = await bind(profileId, nodeId, 443);
    await acknowledge(nodeId);
    expect((await syncStatus(nodeId)).applied).toBe(true);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/bindings/${bindingId}`,
      headers: auth(),
      payload: { port: 8443 },
    });
    expect(res.statusCode, res.body).toBe(200);

    await expect.poll(async () => (await syncStatus(nodeId)).applied, { timeout: 10_000 }).toBe(false);
  });

  it('goes back to pending when the PROFILE changes, though no node row was touched', async () => {
    // The case node.updatedAt cannot see, and the reason this is not a boolean
    // on the list DTO: one profile edit changes the config of every node bound
    // to it.
    const nodeId = await makeNode();
    const profileId = await makeProfile();
    await bind(profileId, nodeId, 443);
    await acknowledge(nodeId);
    expect((await syncStatus(nodeId)).applied).toBe(true);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profileId}`,
      headers: auth(),
      payload: { description: 'edited' },
    });
    expect(res.statusCode, res.body).toBe(200);

    await expect.poll(async () => (await syncStatus(nodeId)).applied, { timeout: 10_000 }).toBe(false);
    const after = await syncStatus(nodeId);
    expect(new Date(after.configChangedAt) > new Date(after.lastInboundSyncAt!)).toBe(true);
  });

  it('a status poll does not make an applied node look pending', async () => {
    // The trap this file caught: the poller writes status / lastStatusMessage /
    // coreVersion to the node row every tick, and stamping the acknowledgement
    // writes to it too. Anchoring "config changed" on node.updatedAt therefore
    // made every node permanently pending, the healthy ones first.
    const nodeId = await makeNode();
    await acknowledge(nodeId);
    expect((await syncStatus(nodeId)).applied).toBe(true);

    await prisma.node.update({
      where: { id: nodeId },
      data: { status: 'degraded', lastStatusMessage: 'xray restarted', coreVersion: '26.3.27' },
    });

    expect((await syncStatus(nodeId)).applied).toBe(true);
  });

  it('carries online separately, because a pending push on a dead node is waiting, not stuck', async () => {
    const nodeId = await makeNode();
    await prisma.node.update({ where: { id: nodeId }, data: { status: 'online' } });
    expect((await syncStatus(nodeId)).online).toBe(true);
    await prisma.node.update({ where: { id: nodeId }, data: { status: 'unreachable' } });
    expect((await syncStatus(nodeId)).online).toBe(false);
  });

  it('the node DTO carries the raw acknowledgement stamp', async () => {
    const nodeId = await makeNode();
    const when = new Date();
    await acknowledge(nodeId, when);
    const res = await app.inject({ method: 'GET', url: `/api/nodes/${nodeId}`, headers: auth() });
    expect(JSON.parse(res.body).lastInboundSyncAt).toBe(when.toISOString());
  });

  /**
   * A-195: two bindings that stood on one single-inbound adapter before A-055
   * refused the second. The node serves one, the last by port; the status says
   * so instead of nothing. Written past the API, which refuses them now.
   */
  it('names the bindings that share a single-inbound adapter, and the one the node serves', async () => {
    const nodeId = await makeNode();
    const ss = async (name: string) =>
      (await prisma.profile.create({
        data: { name, protocol: 'shadowsocks', config: { method: '2022-blake3-aes-128-gcm' } },
        select: { id: true },
      })).id;
    const low = await prisma.profileNodeBinding.create({ data: { nodeId, profileId: await ss('ss-a'), port: 8388, transport: 'tcp' } });
    const high = await prisma.profileNodeBinding.create({ data: { nodeId, profileId: await ss('ss-b'), port: 8389, transport: 'tcp' } });
    // xray takes many: two of them are no conflict.
    await bind(await makeProfile(), nodeId, 443);
    await bind(await makeProfile(), nodeId, 8443);

    const s = (await syncStatus(nodeId)) as unknown as {
      slotConflicts: { protocol: string; engine: string; bindings: { bindingId: string; port: number }[]; servedBindingId: string }[];
    };
    expect(s.slotConflicts).toHaveLength(1);
    expect(s.slotConflicts[0]).toMatchObject({ protocol: 'shadowsocks', servedBindingId: high.id });
    expect(s.slotConflicts[0]!.bindings.map((b) => b.bindingId)).toEqual([low.id, high.id]);

    // A disabled binding takes no slot on the node.
    await prisma.profileNodeBinding.update({ where: { id: low.id }, data: { enabled: false } });
    expect(((await syncStatus(nodeId)) as unknown as { slotConflicts: unknown[] }).slotConflicts).toEqual([]);
  });

  it('A-204: names where a squad\'s limit on a user does not hold, and not for a disabled profile', async () => {
    const nodeId = await makeNode();
    const raw = async (name: string, protocol: string, port: number) => {
      const p = await prisma.profile.create({ data: { name, protocol, config: {} }, select: { id: true } });
      return prisma.profileNodeBinding.create({ data: { nodeId, profileId: p.id, port, transport: 'tcp' } });
    };
    const m1 = await raw('mi-a', 'mieru', 2001);
    const m2 = await raw('mi-b', 'mieru', 2002);
    const mt = await raw('mt-a', 'mtproto', 4443);
    type Gaps = { userScopeGaps: { bindingId: string; gap: string; profileName: string }[] };
    const gaps = ((await syncStatus(nodeId)) as unknown as Gaps).userScopeGaps;
    expect(gaps.map((g) => [g.bindingId, g.gap]).sort()).toEqual(
      [[m1.id, 'shared-users'], [m2.id, 'shared-users'], [mt.id, 'shared-secret']].sort(),
    );

    // A disabled profile is not pushed: its mtproto names no secret, and the
    // mieru left alone has nothing to cross into.
    await prisma.profile.updateMany({ where: { id: { in: [m2.profileId, mt.profileId] } }, data: { enabled: false } });
    expect(((await syncStatus(nodeId)) as unknown as Gaps).userScopeGaps).toEqual([]);
  });

  it('404s for a node that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes/00000000-0000-4000-8000-000000000000/sync-status',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
