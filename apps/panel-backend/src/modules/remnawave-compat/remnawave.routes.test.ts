import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID } from '../squads/squads.constants.js';

// The facade only mounts when REMNAWAVE_COMPAT_ENABLED is set at config-load
// time (frozen singleton). This file sets it BEFORE the first dynamic import of
// app/config, so the facade is live here without affecting other test files
// (vitest isolates modules per file).

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

// Full-admin token (empty scopes) + a read-only scoped token for the 403 check.
const adminToken = `icp_rwtest_admin_${Date.now()}`;
const roToken = `icp_rwtest_ro_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Users are tracked by the NUMERIC reference the facade hands out — the
// native uuid is no longer on the wire in the 3.x shape.
const createdUserRefs: number[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.createMany({
    data: [
      { name: 'rwtest-admin', tokenHash: sha(adminToken), scopes: [] },
      { name: 'rwtest-ro', tokenHash: sha(roToken), scopes: ['users:read'] },
    ],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  if (createdUserRefs.length) {
    await prisma.groupMember.deleteMany({ where: { user: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } } });
    await prisma.userTraffic.deleteMany({ where: { user: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } } });
    await prisma.user.deleteMany({ where: { numericId: { in: createdUserRefs.map((n) => BigInt(n)) } } });
  }
  await prisma.apiToken.deleteMany({ where: { tokenHash: { in: [sha(adminToken), sha(roToken)] } } });
  await app.close();
});

async function createUser(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: `/${PREFIX}/api/users`,
    headers: bearer(adminToken),
    payload: body,
  });
  return res;
}

describe('remnawave-compat facade (facade-on)', () => {
  it('wraps success in {response} with application/json', async () => {
    const res = await createUser({ username: `rwt_env_${Date.now()}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body).toHaveProperty('response');
    // 3.x identity is the numeric `id`; `uuid` must be ABSENT, or the client
    // adopts it and then refuses to send it.
    expect(body.response).toHaveProperty('id');
    expect(typeof body.response.id).toBe('number');
    expect(body.response).not.toHaveProperty('uuid');
    createdUserRefs.push(body.response.id);
  });

  it('accepts hwidDeviceLimit:0 (unlimited) on create and reads it back as 0', async () => {
    const create = await createUser({ username: `rwt_hwid0_${Date.now()}`, hwidDeviceLimit: 0 });
    expect(create.statusCode).toBe(200);
    const ref = create.json().response.id;
    createdUserRefs.push(ref);
    const get = await app.inject({ method: 'GET', url: `/${PREFIX}/api/users/${ref}`, headers: bearer(adminToken) });
    expect(get.statusCode).toBe(200);
    expect(get.json().response.hwidDeviceLimit).toBe(0);
  });

  it('empty activeInternalSquads → no-access group (NOT the All squad), hidden from the echo', async () => {
    const create = await createUser({ username: `rwt_noacc_${Date.now()}`, activeInternalSquads: [] });
    const ref = create.json().response.id;
    createdUserRefs.push(ref);
    // Echo hides the system groups → empty list.
    expect(create.json().response.activeInternalSquads).toEqual([]);
    // Natively the user is in the no-access group, never the All squad.
    const row = await prisma.user.findFirst({ where: { numericId: BigInt(ref) }, select: { id: true } });
    const members = await prisma.groupMember.findMany({ where: { userId: row.id }, select: { groupId: true } });
    const ids = members.map((m: { groupId: string }) => m.groupId);
    expect(ids).toContain(NO_ACCESS_SQUAD_ID);
    expect(ids).not.toContain(ALL_SQUAD_ID);
  });

  it('duplicate username → A019 error code', async () => {
    const username = `rwt_dup_${Date.now()}`;
    const first = await createUser({ username });
    createdUserRefs.push(first.json().response.id);
    const dup = await createUser({ username });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().errorCode).toBe('A019');
  });

  // 3.x looks a user up by streaming with a filter; the by-telegram-id route is
  // 2.x-only and no longer served. The filter must actually narrow: the client
  // re-checks the rows it gets, so an ignored filter is not a wrong answer — it
  // is a full table scan per lookup, which only a narrowing assertion catches.
  it('the stream filters by telegramId instead of the 2.x lookup route', async () => {
    const tg = String(Date.now()).slice(-9);
    const create = await createUser({ username: `rwt_tg_${Date.now()}`, telegramId: tg });
    const ref = create.json().response.id;
    createdUserRefs.push(ref);
    // A second user with no telegramId, to prove the filter excludes.
    createdUserRefs.push((await createUser({ username: `rwt_tgx_${Date.now()}` })).json().response.id);

    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/stream?size=100&telegramId=${tg}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json().response.users;
    expect(users.map((u: { id: number }) => u.id)).toEqual([ref]);

    // The 2.x lookup route is gone.
    const legacy = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/by-telegram-id/${tg}`,
      headers: bearer(adminToken),
    });
    expect(legacy.statusCode).toBe(404);
  });

  // An unparseable filter must match NOTHING. Dropping it would widen the query
  // to every user and the client would read that page as the lookup's answer.
  it('an unparseable telegramId filter returns no users, not all of them', async () => {
    createdUserRefs.push((await createUser({ username: `rwt_tgbad_${Date.now()}` })).json().response.id);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/stream?size=100&telegramId=not-a-number`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.users).toEqual([]);
  });

  it('GET a non-existent user → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/999999999999`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('a scoped token without users:write is 403 on create (least-privilege enforced on the facade)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/users`,
      headers: bearer(roToken),
      payload: { username: `rwt_scope_${Date.now()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('enable/disable flips status to ACTIVE/DISABLED', async () => {
    const create = await createUser({ username: `rwt_toggle_${Date.now()}` });
    const uuid = create.json().response.id;
    createdUserRefs.push(uuid);
    const dis = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/users/${uuid}/actions/disable`,
      headers: bearer(adminToken),
    });
    expect(dis.json().response.status).toBe('DISABLED');
    const en = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/users/${uuid}/actions/enable`,
      headers: bearer(adminToken),
    });
    expect(en.json().response.status).toBe('ACTIVE');
  });

  it('trafficLimitBytes round-trips BYTE-EXACT (non-GiB-aligned) on create + read', async () => {
    // 2.5 GB used + 10 GiB — NOT a whole-GiB multiple. The old GiB-quantizing
    // path echoed a different byte count and the shop rolled back the paid
    // activation on its exact-int verify. Byte-precise must round-trip unchanged.
    const bytes = 13_237_418_240;
    const create = await createUser({ username: `rwt_bytes_${Date.now()}`, trafficLimitBytes: bytes });
    expect(create.statusCode).toBe(200);
    const uuid = create.json().response.id;
    createdUserRefs.push(uuid);
    expect(create.json().response.trafficLimitBytes).toBe(bytes);
    const get = await app.inject({ method: 'GET', url: `/${PREFIX}/api/users/${uuid}`, headers: bearer(adminToken) });
    expect(get.json().response.trafficLimitBytes).toBe(bytes);
  });

  it('PATCH trafficLimitBytes updates byte-exact (carryover value)', async () => {
    const create = await createUser({ username: `rwt_bpatch_${Date.now()}` });
    const ref = create.json().response.id;
    createdUserRefs.push(ref);
    const newBytes = 61_424_509_440; // 50 GiB + non-aligned carryover
    const patch = await app.inject({
      method: 'PATCH',
      url: `/${PREFIX}/api/users`,
      headers: bearer(adminToken),
      // The 3.x selector is the integer `id`, not `uuid`.
      payload: { id: ref, trafficLimitBytes: newBytes },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().response.trafficLimitBytes).toBe(newBytes);
  });

  it('the All squad (and no-access) is hidden from /internal-squads — picker must match the reader', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/internal-squads`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().response.internalSquads.map((s: { uuid: string }) => s.uuid);
    // Both system groups are hidden: reads strip them from activeInternalSquads,
    // so presenting them here would break the shop's set-equality verify.
    expect(ids).not.toContain(ALL_SQUAD_ID);
    expect(ids).not.toContain(NO_ACCESS_SQUAD_ID);
  });

  it('create is atomic-or-clean: a post-create failure leaves NO orphan user', async () => {
    // An invalid expireAt is accepted at the Remna layer (any string) but makes
    // the follow-up UpdateUserSchema.parse throw AFTER the row is committed. The
    // handler must compensate (soft-delete) so no never-expiring orphan lingers
    // and the username is freed — otherwise a paid activation reported "failed"
    // would leave a phantom active user the shop never cleans up.
    const username = `rwt_atomic_${Date.now()}`;
    const bad = await createUser({ username, expireAt: 'not-a-real-date' });
    expect(bad.statusCode).toBe(400);
    // No orphan: the username must be free (compensated), so a lookup 404s...
    const lookup = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/by-username/${username}`,
      headers: bearer(adminToken),
    });
    expect(lookup.statusCode).toBe(404);
    // ...and re-creating with the same username now succeeds (index freed).
    const retry = await createUser({ username });
    expect(retry.statusCode).toBe(200);
    createdUserRefs.push(retry.json().response.id);
  });

  it('a reference that is not a numeric id → 404, not a 500', async () => {
    // "Unparseable" and "unknown" are deliberately the same answer: the client
    // normalizes both to an empty lookup, and it must be able to reconcile or
    // clean the id up rather than see a lookup failure it holds forever. A
    // non-numeric reference never reaches the database, so the old Prisma-level
    // uuid-cast failure cannot arise either.
    for (const ref of ['not-a-uuid', '00000000-0000-0000-0000-0000000000ff', '0', '-1', '1e3']) {
      const res = await app.inject({
        method: 'GET',
        url: `/${PREFIX}/api/users/${ref}`,
        headers: bearer(adminToken),
      });
      expect(res.statusCode, ref).toBe(404);
      expect(res.json().errorCode, ref).toBe('A063');
    }
  });

  it('bandwidth-stats tolerates a malformed date param (falls back, no 500)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/bandwidth-stats/nodes?start=2026-07-01T00:00:00Z&end=garbage`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().response).toHaveProperty('topNodes');
  });
});
