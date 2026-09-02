import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { applyInboundsForNode } from './inbounds.queue.js';
import { mtprotoNodesForUser, mtprotoUsersForNode } from './mtproto-access.js';

/**
 * The MTProto secret goes only where a squad grants MTProto.
 *
 * Every other per-user credential in the push is inert on an adapter that has no
 * use for it, which is why they are all sent unconditionally. The MTProto secret
 * stopped being one of those when the mtprotoproxy engine arrived: the adapter
 * writes what it receives into `USERS`, so a secret that reaches the node IS an
 * account on that proxy. Sending everyone's meant the inbound served everyone the
 * node had ever heard of — measured 2026-09-02, all five live buyers in the
 * `USERS` of a test inbound nobody had been given — which made the squad a rule
 * about who receives the LINK, and nothing at all about who gets in.
 */

let app: FastifyInstance;
let token: string;
let seq = 0;

const auth = () => ({ authorization: `Bearer ${token}` });

async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:8443`,
      status: 'online',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return row.id;
}

async function profileOn(nodeId: string, protocol: string, port: number): Promise<string> {
  seq += 1;
  const profile = await prisma.profile.create({
    data: { name: `p-${protocol}-${seq}`, protocol, config: { domain: 'www.cloudflare.com' }, enabled: true },
  });
  await prisma.profileNodeBinding.create({
    data: { profileId: profile.id, nodeId, port, enabled: true },
  });
  return profile.id;
}

async function squad(name: string, profileIds: string[]): Promise<string> {
  seq += 1;
  const group = await prisma.group.create({ data: { name: `${name}-${seq}` } });
  for (const profileId of profileIds) {
    await prisma.groupProfile.create({ data: { groupId: group.id, profileId } });
  }
  return group.id;
}

async function user(name: string, groupIds: string[]): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: auth(),
    payload: { username: `${name}-${seq}`, groupIds },
  });
  if (res.statusCode !== 201) throw new Error(`createUser: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('who a node may serve MTProto to', () => {
  it('is the members of a squad granting an mtproto profile bound to it', async () => {
    const nodeId = await node('mt');
    const mtproto = await profileOn(nodeId, 'mtproto', 2083);
    const xray = await profileOn(nodeId, 'xray', 443);
    const withMt = await squad('with-mt', [mtproto, xray]);
    const withoutMt = await squad('without-mt', [xray]);

    const buyer = await user('buyer', [withMt]);
    const other = await user('other', [withoutMt]);

    const allowed = await mtprotoUsersForNode(nodeId);
    expect(allowed.has(buyer)).toBe(true);
    expect(allowed.has(other), 'a squad without MTProto still got an account on the proxy').toBe(
      false,
    );
  });

  it('is nobody on a node carrying no mtproto inbound', async () => {
    const nodeId = await node('no-mt');
    const xray = await profileOn(nodeId, 'xray', 443);
    await user('buyer', [await squad('xray-only', [xray])]);
    expect((await mtprotoUsersForNode(nodeId)).size).toBe(0);
  });

  it('answers the same question from the user’s side', async () => {
    // The per-user queue holds a person and fans out to every node, so it needs
    // the mirror image. The two must agree or one push grants what the other
    // takes away, every sync, forever.
    const withMtNode = await node('mt');
    const plainNode = await node('plain');
    const mtproto = await profileOn(withMtNode, 'mtproto', 2083);
    await profileOn(plainNode, 'xray', 443);
    const buyer = await user('buyer', [await squad('with-mt', [mtproto])]);

    const nodes = await mtprotoNodesForUser(buyer);
    expect(nodes.has(withMtNode)).toBe(true);
    expect(nodes.has(plainNode)).toBe(false);
    expect((await mtprotoUsersForNode(withMtNode)).has(buyer)).toBe(true);
  });

  it('stops naming a node whose mtproto binding is disabled', async () => {
    const nodeId = await node('mt');
    const mtproto = await profileOn(nodeId, 'mtproto', 2083);
    const buyer = await user('buyer', [await squad('with-mt', [mtproto])]);
    await prisma.profileNodeBinding.updateMany({
      where: { profileId: mtproto },
      data: { enabled: false },
    });
    expect((await mtprotoUsersForNode(nodeId)).size).toBe(0);
    expect((await mtprotoNodesForUser(buyer)).size).toBe(0);
  });
});

describe('what the inbound sync actually pushes', () => {
  it('carries the secret for the entitled user and not for the other', async () => {
    const nodeId = await node('mt');
    const mtproto = await profileOn(nodeId, 'mtproto', 2083);
    const xray = await profileOn(nodeId, 'xray', 443);
    const buyer = await user('buyer', [await squad('with-mt', [mtproto, xray])]);
    const other = await user('other', [await squad('without-mt', [xray])]);

    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({
      ok: true,
      applied: 2,
      skipped: 0,
    });
    vi.spyOn(NodeTransport.prototype, 'retainUsers').mockResolvedValue({
      ok: true,
      reconciled: [],
    });
    const addUser = vi.spyOn(NodeTransport.prototype, 'addUser').mockResolvedValue(undefined);

    await applyInboundsForNode(nodeId);

    const sent = new Map(
      addUser.mock.calls.map(([req]) => [req.userId, req.credentials.mtprotoSecret]),
    );
    expect(sent.get(buyer), 'the entitled buyer got no secret').toMatch(/^[0-9a-f]{32}$/);
    expect(
      sent.get(other),
      'a user whose squad grants no MTProto was given an account on the proxy',
    ).toBeUndefined();
    // And they were still pushed: the absence is a statement about MTProto, not
    // about the person. The adapter reads it as a revocation.
    expect(sent.has(other)).toBe(true);
  });
});
