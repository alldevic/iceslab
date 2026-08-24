import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * The facade presents itself as Remnawave 3.x. This file pins the parts of that
 * claim the client derives everything else from — the version it reads, the
 * identity it is handed, and the exact 404 shape it uses to tell "this panel
 * does not have that route" apart from "that user does not exist".
 *
 * That last one is why this file is empirical rather than a code read: the
 * capability routes we deliberately do NOT serve are safe only because the
 * client can classify their 404 and stop asking. If the framework ever grows a
 * not-found handler that stamps an errorCode into the body, the classification
 * silently inverts — the client would read "route exists, entity missing",
 * never learn the capability is absent, and retry the same doomed call on every
 * squad change forever. Nothing about that is visible from reading our routes.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const adminToken = `icp_rw3_${Date.now()}`;
// The deployment token is least-privilege (see docs/remnawave-compat.md), and a
// scoped token takes a different path through the auth hooks than a full one.
const scopedToken = `icp_rw3_scoped_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const createdUserRefs: number[] = [];
const createdSquadIds: string[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([import('../../app.js'), import('../../prisma.js')]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.createMany({
    data: [
      { name: 'rw3', tokenHash: sha(adminToken), scopes: [] },
      { name: 'rw3-scoped', tokenHash: sha(scopedToken), scopes: ['users:read', 'users:write', 'squads:read', 'squads:write'] },
    ],
  });
});

afterAll(async () => {
  const ids = createdUserRefs.map((n) => BigInt(n));
  if (ids.length) {
    await prisma.groupMember.deleteMany({ where: { user: { numericId: { in: ids } } } });
    await prisma.userTraffic.deleteMany({ where: { user: { numericId: { in: ids } } } });
    await prisma.user.deleteMany({ where: { numericId: { in: ids } } });
  }
  if (createdSquadIds.length) await prisma.group.deleteMany({ where: { id: { in: createdSquadIds } } });
  await prisma.apiToken.deleteMany({ where: { tokenHash: { in: [sha(adminToken), sha(scopedToken)] } } });
  await app.close();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken) });
const send = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken), payload: payload ?? {} });

async function mkUser(body: Record<string, unknown> = {}): Promise<number> {
  const res = await send('POST', 'users', { username: `rw3_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...body });
  const ref = res.json().response.id as number;
  createdUserRefs.push(ref);
  return ref;
}

async function mkSquad(): Promise<string> {
  const g = await prisma.group.create({ data: { name: `rw3-squad-${Date.now()}-${Math.random()}` } });
  createdSquadIds.push(g.id);
  return g.id as string;
}

describe('rw3: the version this facade declares', () => {
  it('answers /system/metadata with a 3.x version', async () => {
    const res = await get('system/metadata');
    expect(res.statusCode).toBe(200);
    const version = res.json().response.version as string;
    // The client takes the MAJOR and derives the identity model and the whole
    // route set from it. A 2.x string here would re-point every user-scoped call
    // at a UUID identity this facade no longer emits.
    expect(version).toMatch(/^3\./);
  });
});

describe('rw3: user identity is the numeric id', () => {
  it('a user object carries a numeric `id` and NO `uuid`', async () => {
    const ref = await mkUser();
    const user = (await get(`users/${ref}`)).json().response;
    expect(typeof user.id).toBe('number');
    expect(user.id).toBe(ref);
    // Present-but-wrong is worse than absent: the client prefers `uuid` when it
    // is there, and would adopt an identifier its own 3.x guard then refuses to
    // send — every later call for this subscriber would fail with no request
    // made and no error to see.
    expect(user).not.toHaveProperty('uuid');
  });

  it('the numeric id is stable across writes', async () => {
    const ref = await mkUser();
    // It travels in the shop's database as this subscriber's identity, so a
    // write that renumbered them would detach a paying customer from their
    // account.
    const after = await send('POST', `users/${ref}/actions/disable`);
    expect(after.json().response.id).toBe(ref);
    const revoked = await send('POST', `users/${ref}/actions/revoke`);
    expect(revoked.json().response.id).toBe(ref);
  });
});

describe('rw3: the targeted squad bulk routes', () => {
  // These are NOT optional the way the other 3.x-only routes are: once the
  // client holds numeric ids it has no per-user fallback for them, so a 404
  // here does not degrade squad assignment, it stops it.
  it('add-many-users / remove-many-users move membership by numeric id', async () => {
    const squad = await mkSquad();
    const a = await mkUser();
    const b = await mkUser();

    const added = await send('POST', `internal-squads/${squad}/bulk-actions/add-many-users`, {
      userIds: [a, b],
    });
    expect(added.statusCode).toBe(200);
    for (const ref of [a, b]) {
      expect((await get(`users/${ref}`)).json().response.activeInternalSquads.map((s: { uuid: string }) => s.uuid)).toEqual([squad]);
    }

    const removed = await send('DELETE', `internal-squads/${squad}/bulk-actions/remove-many-users`, {
      userIds: [a, b],
    });
    expect(removed.statusCode).toBe(200);
    for (const ref of [a, b]) {
      // Losing the last real squad means no access, never the "All" squad.
      expect((await get(`users/${ref}`)).json().response.activeInternalSquads).toEqual([]);
    }
  });

  it('a reference the panel never issued is skipped, not fatal to the chunk', async () => {
    // The client sends a whole chunk; erroring on one stale id would abandon the
    // rest of it and leave the batch half-applied.
    const squad = await mkSquad();
    const real = await mkUser();
    const res = await send('POST', `internal-squads/${squad}/bulk-actions/add-many-users`, {
      userIds: [999_999_999_999, real],
    });
    expect(res.statusCode).toBe(200);
    expect((await get(`users/${real}`)).json().response.activeInternalSquads.map((s: { uuid: string }) => s.uuid)).toEqual([squad]);
  });
});

describe('rw3: routes we deliberately do not serve must read as ABSENT, not as empty', () => {
  // Each of these is gated behind a capability the client probes once and then
  // remembers. It classifies the answer by SHAPE: a 404 with no errorCode and a
  // "not found"/"cannot post" message means the route is missing (stop asking
  // and use the fallback); a 404 WITH an errorCode means the route exists and
  // the entity did not, which teaches it nothing and makes it retry forever.
  //
  // The four capability routes that used to be here are SERVED as of
  // 2026-08-24 (see remnawave.admin-routes.test.ts): the shop never called them
  // while it could not certify our declared version, its `dev` certifies 3.3.2,
  // and its admin panel is our admin panel — "unserved" stopped meaning "unused
  // surface". What is left is genuinely dead in the facade: the shop encrypts
  // happ links locally, and the 2.x `add-users` meant ALL users, so the client
  // never calls it.
  const absent: [('POST' | 'DELETE'), string][] = [
    ['POST', 'system/tools/happ/encrypt'],
    ['POST', 'internal-squads/11111111-1111-4111-8111-111111111111/bulk-actions/add-users'],
  ];

  for (const [method, url] of absent) {
    it(`${method} /${url} answers in the "route absent" shape`, async () => {
      const res = await send(method, url, {});
      expect(res.statusCode, url).toBe(404);
      const body = res.json();
      expect(body.errorCode, url).toBeUndefined();
      expect(body.code, url).toBeUndefined();
      expect(String(body.message ?? '').toLowerCase(), url).toMatch(/not found|cannot post|cannot get/);
    });
  }

  it('the absent-route shape survives a least-privilege token', async () => {
    // The real deployment token is scoped, and scope enforcement is a different
    // hook stage. If an unserved route came back 403 instead, the client would
    // read a permissions problem rather than a missing route — it would never
    // learn the capability is absent and would retry the same doomed call on
    // every squad change.
    const res = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/system/tools/happ/encrypt`,
      headers: bearer(scopedToken),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBeUndefined();
  });

  it('and a route we now SERVE is reachable with that same token', async () => {
    // The other half of the same hazard, and the one serving these four
    // introduced: a route mapped to no scope is default-denied with a 403, which
    // the client reads as a permissions problem and retries forever. `connections`
    // was unmapped and `bandwidth-stats/nodes/usage` resolved to system:write —
    // both unreachable for a users/squads-scoped deployment token.
    for (const url of [
      'users/bulk/update-squads',
      'connections/drop',
      'bandwidth-stats/nodes/users',
      'bandwidth-stats/nodes/usage',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/${PREFIX}/api/${url}`,
        headers: bearer(scopedToken),
        payload: {},
      });
      expect(res.statusCode, `${url} must not be scope-denied`).not.toBe(403);
    }
  });

  it('a route we DO serve reports a missing user with an errorCode instead', async () => {
    // The contrast is the whole point: this must NOT look like an absent route,
    // or the client would conclude the panel has no user lookup at all.
    const res = await get('users/999999999999');
    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('A063');
  });
});
