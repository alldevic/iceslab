// The SCOPE of a squad edit, asked at the door the subscriber knocks on.
//
// `updateSquad` replaces four join sets — profiles, hosts, exits, policies —
// and each replacement starts by wiping the old rows. All four wipes read
// correctly (`where: { groupId: id }`) and nothing observed their scope: with
// the groupId dropped, editing ANY squad strips every other squad's profiles,
// and the whole customer base loses its endpoints on the next subscription
// fetch. The panel reports the edit as saved, no error is raised anywhere, and
// the squad the admin was editing looks exactly right.
//
// So every case here edits one squad and then asks a DIFFERENT squad's member
// what their client would receive. Checking the edited squad cannot see this:
// its own rows are supposed to be replaced.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from '../subscription/subscription.bindings-cache.js';
import { createCascade } from '../cascades/cascade.service.js';

let app: FastifyInstance;
let token: string;

// The squad-set binding cache is in-process and wired in index.ts, not
// buildApp: without this a second /sub read after an edit is served the answer
// from before it. Subscribed once, the bus has no unsubscribe.
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

const post = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, `${url} -> ${res.body}`).toBe(201);
  return JSON.parse(res.body);
};

const put = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: 'PUT', url, headers: auth(), payload });
  expect(res.statusCode, `${url} -> ${res.body}`).toBe(200);
  return JSON.parse(res.body);
};

/** One self-contained side: a profile on its own node, its hosts, a squad
 *  holding it and a member of that squad. Two of these is the smallest fixture
 *  in which a squad edit's scope is visible at all. */
async function side(tag: string, remarks: string[]) {
  const profile = await post('/api/profiles', {
    name: `${tag}-profile`,
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
  });
  const node = await post('/api/nodes', {
    name: `${tag}-node`,
    address: `${tag}.example.com`,
    protocol: 'xray',
  });
  const hosts = [];
  for (const remark of remarks) {
    hosts.push(
      await post('/api/hosts', { profileId: profile.id, nodeId: node.id, port: 443, remark }),
    );
  }
  const squad = await post('/api/squads', { name: `${tag}-squad`, profileIds: [profile.id] });
  const user = await post('/api/users', { username: `${tag}_user`, groupIds: [squad.id] });
  return { profile, node, hosts, squad, user };
}

/** What the client would actually list, read out of the subscription body. */
async function serverNames(subToken: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/sub/${subToken}?format=plain` });
  expect(res.statusCode).toBe(200);
  return Buffer.from(res.body, 'base64')
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((uri) => decodeURIComponent(uri.split('#')[1] ?? ''))
    .sort();
}

const squadById = async (id: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/squads', headers: auth() });
  return JSON.parse(res.body).squads.find((s: { id: string }) => s.id === id);
};

describe('editing one squad leaves every other squad standing', () => {
  it('does not take another squad’s profiles away', async () => {
    const a = await side('alpha', ['A-1']);
    const b = await side('beta', ['B-1']);
    expect(await serverNames(b.user.subscriptionToken)).toEqual(['B-1']);

    // A profile-set replacement on the OTHER squad. Even a no-op one runs the
    // wipe, which is the whole point: the admin changed nothing about beta.
    await put(`/api/squads/${a.squad.id}`, { profileIds: [a.profile.id] });

    expect(
      await serverNames(b.user.subscriptionToken),
      'editing alpha left beta’s member with no endpoints',
    ).toEqual(['B-1']);
    expect(await serverNames(a.user.subscriptionToken)).toEqual(['A-1']);
  });

  it('does not tear down another squad’s host restriction', async () => {
    const a = await side('alpha', ['A-1']);
    const b = await side('beta', ['B-1', 'B-2']);
    // An empty host list means EVERY host, so a wiped restriction hands out
    // more than the operator granted — the failure points the other way here
    // and an "is it still there" check would miss it.
    await put(`/api/squads/${b.squad.id}`, { hostIds: [b.hosts[0].id] });
    expect(await serverNames(b.user.subscriptionToken)).toEqual(['B-1']);

    await put(`/api/squads/${a.squad.id}`, { hostIds: [a.hosts[0].id] });

    expect(
      await serverNames(b.user.subscriptionToken),
      'editing alpha handed beta a host it was not granted',
    ).toEqual(['B-1']);
  });

  it('does not revoke another squad’s route-policy grant', async () => {
    const a = await side('alpha', ['A-1']);
    const b = await side('beta', ['B-1']);
    const policy = await post('/api/route-policies', {
      name: 'No ads',
      blockDomains: ['geosite:category-ads-all'],
    });
    await put(`/api/squads/${b.squad.id}`, { policyIds: [policy.id] });

    await put(`/api/squads/${a.squad.id}`, { policyIds: [] });

    expect((await squadById(b.squad.id)).policyIds).toEqual([policy.id]);
  });

  it('does not clear another squad’s exit allow-list', async () => {
    const a = await side('alpha', ['A-1']);
    const b = await side('beta', ['B-1']);
    const exit = await post('/api/nodes', {
      name: 'exit-node',
      address: 'exit.example.com',
      protocol: 'xray',
    });
    const cascade = await createCascade({
      name: 'c1',
      enabled: true,
      positions: [
        { position: 0, nodeIds: [b.node.id], entryProtocol: 'xray', linkProtocol: 'xray' },
      ],
      directions: [{ countryCode: 'NL', nodeIds: [exit.id] }],
    });
    await put(`/api/squads/${b.squad.id}`, {
      exitAcl: [{ cascadeId: cascade.id, exitNodeIds: [exit.id] }],
    });

    await put(`/api/squads/${a.squad.id}`, { exitAcl: [] });

    // Cleared, this squad stops restricting anything and its members reach
    // every exit of the cascade — the same leak as the host list above.
    expect((await squadById(b.squad.id)).exitAcl).toEqual([
      { cascadeId: cascade.id, exitNodeIds: [exit.id] },
    ]);
  });
});
