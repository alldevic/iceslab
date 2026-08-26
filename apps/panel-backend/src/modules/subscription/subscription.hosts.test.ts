import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';

/**
 * What a subscription contains is decided by hosts, and until 2026-07-30 a
 * binding with none still emitted one nameless endpoint labelled with the NODE
 * name. Seen in the field: a host was deleted in the panel and came back in the
 * client as "nl2".
 *
 * The rows below pin the two ways an operator reaches zero hosts, delete and
 * disable, because the panel promises both remove the line ("Off hides it from
 * every subscription") and nothing tested that promise.
 */
let app: FastifyInstance;
let token: string;

// Cache-busting is wired in index.ts, not buildApp, so a test that edits config
// mid-run and re-reads the subscription would otherwise be served the cached
// answer. Subscribed once: the bus has no unsubscribe.
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

async function seed() {
  const profile = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: auth(),
        payload: {
          name: 'sub-profile',
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
      })
    ).body,
  );
  const node = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: auth(),
        payload: { name: 'sub-node', address: 'sub.example.com', protocol: 'xray' },
      })
    ).body,
  );
  const host = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hosts',
        headers: auth(),
        payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'Direct' },
      })
    ).body,
  );
  const squad = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/squads',
        headers: auth(),
        payload: { name: 'sub-squad', profileIds: [profile.id] },
      })
    ).body,
  );
  const user = JSON.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: auth(),
        payload: { username: 'sub_user', groupIds: [squad.id] },
      })
    ).body,
  );
  return { profile, node, host, squad, user };
}

/** Server names the client would show, one per line of the plain format. */
async function serverNames(subToken: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/sub/${subToken}?format=plain` });
  expect(res.statusCode).toBe(200);
  const body = Buffer.from(res.body, 'base64').toString('utf8');
  return body
    .split('\n')
    .filter(Boolean)
    .map((uri) => decodeURIComponent(uri.split('#')[1] ?? ''));
}

describe('subscription contents follow hosts', () => {
  it('serves the host, named after it rather than the node', async () => {
    const { user } = await seed();
    const names = await serverNames(user.subscriptionToken);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Direct');
    expect(names[0]).not.toContain('sub-node');
  });

  it('drops the line when the last host is deleted', async () => {
    const { host, user } = await seed();
    await app.inject({ method: 'DELETE', url: `/api/hosts/${host.id}`, headers: auth() });
    // The regression: this used to return one endpoint named "sub-node",
    // because a binding with no hosts fell back to a single nameless row.
    expect(await serverNames(user.subscriptionToken)).toEqual([]);
  });

  it('drops the line when the last host is merely switched off', async () => {
    const { host, user } = await seed();
    await app.inject({
      method: 'PUT',
      url: `/api/hosts/${host.id}`,
      headers: auth(),
      payload: { enabled: false },
    });
    // The panel says "Off hides it from every subscription" under that toggle.
    expect(await serverNames(user.subscriptionToken)).toEqual([]);
  });

  it('a squad that names hosts hands out only those', async () => {
    const { profile, node, host, user } = await seed();
    const second = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hosts',
          headers: auth(),
          payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
        })
      ).body,
    );
    expect(await serverNames(user.subscriptionToken)).toHaveLength(2);

    // Narrow the ONLY squad this user is in to the second host.
    const squad = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/squads', headers: auth() })).body,
    ).squads.find((s: { name: string }) => s.name === 'sub-squad');
    await app.inject({
      method: 'PUT',
      url: `/api/squads/${squad.id}`,
      headers: auth(),
      payload: { hostIds: [second.id] },
    });

    const names = await serverNames(user.subscriptionToken);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('CDN');
    // The point of the whole feature: one profile, one inbound on the node,
    // different squads reaching different hosts of it.
    expect(host.id).toBeTruthy();
  });

  it('an empty list is not an empty squad: it restores every host', async () => {
    const { profile, node, user } = await seed();
    await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth(),
      payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
    });
    const squad = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/squads', headers: auth() })).body,
    ).squads.find((s: { name: string }) => s.name === 'sub-squad');

    await app.inject({
      method: 'PUT',
      url: `/api/squads/${squad.id}`,
      headers: auth(),
      payload: { hostIds: [] },
    });
    // Clearing the list is how an operator removes the restriction, so it must
    // not read as "this squad reaches nothing".
    expect(await serverNames(user.subscriptionToken)).toHaveLength(2);
  });

  it('takes the binding with the last host, freeing the port', async () => {
    const { profile, node, host } = await seed();
    await app.inject({ method: 'DELETE', url: `/api/hosts/${host.id}`, headers: auth() });

    // No invisible leftover: the operator sees a node with nothing on it, and
    // the panel agrees.
    const bindings = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/bindings', headers: auth() })).body,
    ).bindings;
    expect(bindings.filter((b: { nodeId: string }) => b.nodeId === node.id)).toHaveLength(0);

    // And the port is genuinely free again: the same port on the same node is
    // accepted, which it was not while the empty binding still held it.
    const again = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth(),
      payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'Second life' },
    });
    expect(again.statusCode).toBe(201);
  });

  it('keeps the binding while any host remains', async () => {
    const { profile, node, host } = await seed();
    await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth(),
      payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
    });
    await app.inject({ method: 'DELETE', url: `/api/hosts/${host.id}`, headers: auth() });
    const bindings = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/bindings', headers: auth() })).body,
    ).bindings;
    // Only the LAST host takes the binding down; removing one of two must not
    // disturb the node at all.
    expect(bindings.filter((b: { nodeId: string }) => b.nodeId === node.id)).toHaveLength(1);
  });

  it('keeps the surviving host when one of two is removed', async () => {
    const { profile, node, host, user } = await seed();
    await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: auth(),
      payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
    });
    await app.inject({ method: 'DELETE', url: `/api/hosts/${host.id}`, headers: auth() });
    const names = await serverNames(user.subscriptionToken);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('CDN');
  });
});

/**
 * Priority decides which endpoint the client tries FIRST, and reorder is the
 * only way an operator sets it. Measured before writing: `priority: i` in
 * `reorderHosts` widened to `priority: 0` — every host on the same rank, so
 * the order the operator dragged them into is thrown away — and the full
 * 1681-test suite stayed green. Nothing anywhere observed what the reorder
 * did, only that it answered 200.
 *
 * Asked here rather than in the table, because the priority column is not the
 * product: the order of the lines in the subscription body is.
 */
describe('reordering hosts', () => {
  it('changes the order the client reads them in', async () => {
    const { profile, node, host, user } = await seed();
    const second = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hosts',
          headers: auth(),
          payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
        })
      ).body,
    );
    const before = await serverNames(user.subscriptionToken);
    expect(before).toEqual(['Direct', 'CDN']);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/hosts/reorder',
      headers: auth(),
      payload: { hostIds: [second.id, host.id] },
    });
    expect(res.statusCode).toBe(200);
    // The response is the operator's confirmation, so it has to carry the new
    // order too — a 200 listing them as they were is a reorder that did not
    // happen, reported as one that did.
    expect(JSON.parse(res.body).hosts.map((h: { remark: string }) => h.remark)).toEqual([
      'CDN',
      'Direct',
    ]);

    expect(
      await serverNames(user.subscriptionToken),
      'the client would still try them in the old order',
    ).toEqual(['CDN', 'Direct']);
  });

  it('refuses the whole list when one id is not a host, changing nothing', async () => {
    // Partially applying a reorder would leave two hosts sharing a rank, which
    // is the same collapsed order the mutation above produced.
    const { profile, node, host, user } = await seed();
    const second = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hosts',
          headers: auth(),
          payload: { profileId: profile.id, nodeId: node.id, port: 443, remark: 'CDN' },
        })
      ).body,
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/api/hosts/reorder',
      headers: auth(),
      payload: { hostIds: [second.id, '00000000-0000-4000-8000-0000000000ff', host.id] },
    });
    expect(res.statusCode).toBe(404);
    expect(await serverNames(user.subscriptionToken)).toEqual(['Direct', 'CDN']);
  });
});
