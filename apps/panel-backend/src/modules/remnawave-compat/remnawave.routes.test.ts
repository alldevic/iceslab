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

const createdUserIds: string[] = [];

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
  if (createdUserIds.length) {
    await prisma.groupMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.userTraffic.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
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
    expect(body.response).toHaveProperty('uuid');
    createdUserIds.push(body.response.uuid);
  });

  it('accepts hwidDeviceLimit:0 (unlimited) on create and reads it back as 0', async () => {
    const create = await createUser({ username: `rwt_hwid0_${Date.now()}`, hwidDeviceLimit: 0 });
    expect(create.statusCode).toBe(200);
    const uuid = create.json().response.uuid;
    createdUserIds.push(uuid);
    const get = await app.inject({ method: 'GET', url: `/${PREFIX}/api/users/${uuid}`, headers: bearer(adminToken) });
    expect(get.statusCode).toBe(200);
    expect(get.json().response.hwidDeviceLimit).toBe(0);
  });

  it('empty activeInternalSquads → no-access group (NOT the All squad), hidden from the echo', async () => {
    const create = await createUser({ username: `rwt_noacc_${Date.now()}`, activeInternalSquads: [] });
    const uuid = create.json().response.uuid;
    createdUserIds.push(uuid);
    // Echo hides the system groups → empty list.
    expect(create.json().response.activeInternalSquads).toEqual([]);
    // Natively the user is in the no-access group, never the All squad.
    const members = await prisma.groupMember.findMany({ where: { userId: uuid }, select: { groupId: true } });
    const ids = members.map((m: { groupId: string }) => m.groupId);
    expect(ids).toContain(NO_ACCESS_SQUAD_ID);
    expect(ids).not.toContain(ALL_SQUAD_ID);
  });

  it('duplicate username → A019 error code', async () => {
    const username = `rwt_dup_${Date.now()}`;
    const first = await createUser({ username });
    createdUserIds.push(first.json().response.uuid);
    const dup = await createUser({ username });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().errorCode).toBe('A019');
  });

  it('by-telegram-id returns an ARRAY', async () => {
    const tg = String(Date.now()).slice(-9);
    const create = await createUser({ username: `rwt_tg_${Date.now()}`, telegramId: tg });
    createdUserIds.push(create.json().response.uuid);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/by-telegram-id/${tg}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().response)).toBe(true);
    expect(res.json().response.length).toBeGreaterThanOrEqual(1);
  });

  it('GET a non-existent user → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/00000000-0000-0000-0000-0000000000ff`,
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
    const uuid = create.json().response.uuid;
    createdUserIds.push(uuid);
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
    const uuid = create.json().response.uuid;
    createdUserIds.push(uuid);
    expect(create.json().response.trafficLimitBytes).toBe(bytes);
    const get = await app.inject({ method: 'GET', url: `/${PREFIX}/api/users/${uuid}`, headers: bearer(adminToken) });
    expect(get.json().response.trafficLimitBytes).toBe(bytes);
  });

  it('PATCH trafficLimitBytes updates byte-exact (carryover value)', async () => {
    const create = await createUser({ username: `rwt_bpatch_${Date.now()}` });
    const uuid = create.json().response.uuid;
    createdUserIds.push(uuid);
    const newBytes = 61_424_509_440; // 50 GiB + non-aligned carryover
    const patch = await app.inject({
      method: 'PATCH',
      url: `/${PREFIX}/api/users`,
      headers: bearer(adminToken),
      payload: { uuid, trafficLimitBytes: newBytes },
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
    createdUserIds.push(retry.json().response.uuid);
  });

  it('a malformed (non-UUID) user id → 404, not a 500', async () => {
    // Prisma P2023 on the @db.Uuid filter must map to the Remnawave-contract
    // not-found, so the shop can reconcile/clean up rather than see a lookup
    // failure it holds forever.
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/users/not-a-uuid`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NOT_FOUND');
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
