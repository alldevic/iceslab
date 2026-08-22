import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID } from '../squads/squads.constants.js';

// R7 REGRESSION SUITE — each test pins a defect found by the empirical sweep
// (agents booted the facade and fired real requests). Every one of these FAILED
// before its fix; they exist so the fix can't silently regress.

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const adminToken = `icp_r7reg_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Users are tracked by the NUMERIC reference the facade hands out — the
// native uuid is no longer on the wire in the 3.x shape.
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
    data: [{ name: 'r7reg-admin', tokenHash: sha(adminToken), scopes: [] }],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  if (createdUserRefs.length) {
    await prisma.groupMember.deleteMany({ where: { user: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } } });
    await prisma.userTraffic.deleteMany({ where: { user: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } } });
    await prisma.user.deleteMany({ where: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } });
  }
  if (createdSquadIds.length) {
    await prisma.groupMember.deleteMany({ where: { groupId: { in: createdSquadIds } } });
    await prisma.group.deleteMany({ where: { id: { in: createdSquadIds } } });
  }
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(adminToken) } });
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken) });
const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken), ...(payload === undefined ? {} : { payload }) });

async function mkUser(body: Record<string, unknown> = {}) {
  const res = await post('users', { username: `r7reg_${Date.now()}_${Math.trunc(performance.now() * 1000)}`, ...body });
  if (res.statusCode === 200) createdUserRefs.push(res.json().response.id);
  return res;
}
async function mkSquad(name?: string) {
  const g = await prisma.group.create({ data: { name: name ?? `r7reg squad ${Date.now()}_${createdSquadIds.length}` } });
  createdSquadIds.push(g.id);
  return g.id as string;
}

/** The wire hands out the numeric reference; assertions that reach into the
 *  database still need the native uuid primary key. */
async function nativeId(ref: number): Promise<string> {
  const row = await prisma.user.findFirst({ where: { numericId: BigInt(ref) }, select: { id: true } });
  return row.id as string;
}

describe('R7: pagination must return every user EXACTLY once (non-unique createdAt tiebreaker)', () => {
  it('a full page-through never skips or duplicates a user, even when all share one createdAt', async () => {
    // Ties are the real production case (createMany shares one timestamp, and
    // concurrent creates collide at DB precision). Without a unique tiebreaker
    // each LIMIT/OFFSET page resolved ties independently -> rows appeared on two
    // pages and their siblings on none, and the shop deactivated those users'
    // paid subscriptions as "not on the panel".
    const N = 24;
    const mine: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = await mkUser();
      mine.push(r.json().response.id);
    }
    // One shared, far-future createdAt: identical sort key (maximum tie) AND
    // deterministically the top of the DESC ordering, so a few pages cover them
    // regardless of what else lives in the test DB.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET created_at = TIMESTAMP '2099-01-01 00:00:00' WHERE numeric_id = ANY($1::bigint[])`,
      mine,
    );

    for (const size of [5, 7]) {
      const seen: number[] = [];
      for (let start = 0; start < N + size * 2; start += size) {
        const res = await get(`users?size=${size}&start=${start}`);
        expect(res.statusCode).toBe(200);
        for (const u of res.json().response.users) seen.push(u.id);
      }
      const mineSeen = seen.filter((id) => mine.includes(id));
      const missing = mine.filter((id) => !mineSeen.includes(id));
      const duplicated = mineSeen.filter((id, i) => mineSeen.indexOf(id) !== i);
      expect({ size, missing, duplicated }).toEqual({ size, missing: [], duplicated: [] });
    }
  });
});

describe('R7: the shop sends Content-Type: application/json on BODYLESS POST/DELETE', () => {
  // panel_api_core._prepare_headers sets that header on every request, so an
  // empty body under it must not be rejected — these are the shop's core
  // enable/disable/reset/delete calls.
  const jsonNoBody = (method: 'POST' | 'DELETE', url: string) =>
    app.inject({
      method,
      url: `/${PREFIX}/api/${url}`,
      headers: { ...bearer(adminToken), 'content-type': 'application/json', 'content-length': '0' },
    });

  it('enable / disable / reset-traffic / DELETE all succeed with an empty JSON body', async () => {
    const uuid = (await mkUser()).json().response.id;
    expect((await jsonNoBody('POST', `users/${uuid}/actions/disable`)).statusCode).toBe(200);
    expect((await jsonNoBody('POST', `users/${uuid}/actions/enable`)).statusCode).toBe(200);
    expect((await jsonNoBody('POST', `users/${uuid}/actions/reset-traffic`)).statusCode).toBe(200);
    expect((await jsonNoBody('DELETE', `users/${uuid}`)).statusCode).toBe(200);
  });

  it('a genuinely malformed JSON body is a clean 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/users`,
      headers: { ...bearer(adminToken), 'content-type': 'application/json' },
      payload: '{"username": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
  });
});

describe('R7: squad ids are normalised (dedupe + case) and system squads are rejected', () => {
  it('a duplicated squad uuid on create is deduped, not a bogus 409 A019', async () => {
    const squad = await mkSquad();
    const res = await mkUser({ activeInternalSquads: [squad, squad] });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.activeInternalSquads.map((s: { uuid: string }) => s.uuid)).toEqual([squad]);
  });

  it('a duplicated / case-variant squad uuid on PATCH is deduped, not a 500', async () => {
    const squad = await mkSquad();
    const ref = (await mkUser()).json().response.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/${PREFIX}/api/users`,
      headers: bearer(adminToken),
      payload: { id: ref, activeInternalSquads: [squad, squad.toUpperCase()] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.activeInternalSquads.map((s: { uuid: string }) => s.uuid)).toEqual([squad]);
  });

  it('the ALL / no-access squad ids are rejected with a 400 instead of silently echoing []', async () => {
    // Accepting them persisted a membership the echo can never show, so the
    // shop's set-equality verify failed forever and rolled back paid activations.
    for (const sys of [ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID]) {
      const res = await mkUser({ activeInternalSquads: [sys] });
      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    }
  });
});

describe('R7: concurrent writes must not 500', () => {
  it('two identical simultaneous squad PATCHes both resolve without a 500', async () => {
    const squad = await mkSquad();
    const ref = (await mkUser()).json().response.id;
    const body = { id: ref, activeInternalSquads: [squad] };
    const results = await Promise.all([
      app.inject({ method: 'PATCH', url: `/${PREFIX}/api/users`, headers: bearer(adminToken), payload: body }),
      app.inject({ method: 'PATCH', url: `/${PREFIX}/api/users`, headers: bearer(adminToken), payload: body }),
    ]);
    expect(results.map((r) => r.statusCode).filter((c) => c >= 500)).toEqual([]);
    const members = await prisma.groupMember.findMany({
      where: { userId: await nativeId(ref) },
      select: { groupId: true },
    });
    expect(members.map((m: { groupId: string }) => m.groupId)).toEqual([squad]);
  });

  it('two simultaneous deletes of the same HWID device do not 500 (idempotent)', async () => {
    const ref = (await mkUser()).json().response.id;
    const userId = await nativeId(ref);
    const hwid = `r7reg-dev-${Date.now()}`;
    await prisma.hwidUserDevice.create({ data: { userId, hwid } });
    const results = await Promise.all([
      // 3.x selector: the numeric userId, not userUuid.
      post('hwid/devices/delete', { userId: ref, hwid }),
      post('hwid/devices/delete', { userId: ref, hwid }),
    ]);
    expect(results.map((r) => r.statusCode).filter((c) => c >= 500)).toEqual([]);
    expect(await prisma.hwidUserDevice.findFirst({ where: { userId, hwid } })).toBeNull();
  });
});

describe('R7: deleting a squad must not hand its members full access (facade on)', () => {
  it('an orphaned member lands in no-access, never in the ALL squad', async () => {
    const squad = await mkSquad();
    const ref = (await mkUser({ activeInternalSquads: [squad] })).json().response.id;
    const squadsService = await import('../squads/squads.service.js');
    await squadsService.deleteSquad(squad);
    const members = await prisma.groupMember.findMany({
      where: { userId: await nativeId(ref) },
      select: { groupId: true },
    });
    const ids = members.map((m: { groupId: string }) => m.groupId);
    expect(ids).toContain(NO_ACCESS_SQUAD_ID);
    expect(ids).not.toContain(ALL_SQUAD_ID);
  });
});

describe('R7: a nonexistent user id is not mistaken for anything else', () => {
  it('PATCH against an absent (well-formed) uuid is 404, not 500', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/${PREFIX}/api/users`,
      headers: bearer(adminToken),
      payload: { uuid: randomUUID(), description: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
