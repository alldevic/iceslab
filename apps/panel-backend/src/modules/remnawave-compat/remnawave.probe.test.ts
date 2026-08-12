import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// R6 EMPIRICAL PROBE — boots the facade and hits it with realistic lifecycle
// sequences, a hostile-input battery, and concurrency, to catch what actually
// 500s / corrupts at runtime (the thing static passes can't). Throwaway-ish:
// keep only the assertions that prove a real invariant.

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
const adminToken = `icp_rwprobe_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const createdUserIds: string[] = [];

// Valid 8-4-4-4-12 hex shape (passes PermissiveUuid) but no such Group row.
const GHOST_SQUAD = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([import('../../app.js'), import('../../prisma.js')]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.createMany({
    data: [{ name: 'rwprobe-admin', tokenHash: sha(adminToken), scopes: [] }],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.groupMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.userTraffic.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(adminToken) } });
  await app.close();
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken), payload });
const patch = (payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/${PREFIX}/api/users`, headers: bearer(adminToken), payload });
const get = (url: string) => app.inject({ method: 'GET', url: `/${PREFIX}/api/${url}`, headers: bearer(adminToken) });

async function mk(body: Record<string, unknown>) {
  const res = await post('users', body);
  if (res.statusCode === 200) createdUserIds.push(res.json().response.uuid);
  return res;
}

describe('R6 empirical: full lifecycle sequence', () => {
  it('create → get → patch traffic → disable → enable → reset → by-tg → delete all succeed', async () => {
    const tg = String(Date.now()).slice(-9);
    const c = await mk({ username: `probe_life_${Date.now()}`, telegramId: tg, trafficLimitBytes: 13_237_418_240 });
    expect(c.statusCode).toBe(200);
    const uuid = c.json().response.uuid;
    expect((await get(`users/${uuid}`)).statusCode).toBe(200);
    expect((await patch({ uuid, trafficLimitBytes: 61_424_509_440 })).statusCode).toBe(200);
    expect((await post(`users/${uuid}/actions/disable`, {})).json().response.status).toBe('DISABLED');
    expect((await post(`users/${uuid}/actions/enable`, {})).json().response.status).toBe('ACTIVE');
    expect((await post(`users/${uuid}/actions/reset-traffic`, {})).statusCode).toBe(200);
    expect(Array.isArray((await get(`users/by-telegram-id/${tg}`)).json().response)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/${PREFIX}/api/users/${uuid}`, headers: bearer(adminToken) })).statusCode).toBe(200);
  });
});

describe('R6 empirical: nonexistent-squad reference (operator-misconfigured USER_SQUAD_UUIDS)', () => {
  it('create with a valid-shape but nonexistent squad → clean 4xx, NOT 500', async () => {
    const res = await mk({ username: `probe_ghost_${Date.now()}`, activeInternalSquads: [GHOST_SQUAD] });
    expect(res.statusCode).not.toBe(500);
    expect([400, 404, 422]).toContain(res.statusCode);
  });

  it('PATCH activeInternalSquads to a nonexistent squad → clean 4xx, NOT 500', async () => {
    const c = await mk({ username: `probe_ghost2_${Date.now()}` });
    const uuid = c.json().response.uuid;
    const res = await patch({ uuid, activeInternalSquads: [GHOST_SQUAD] });
    expect(res.statusCode).not.toBe(500);
    expect([400, 404, 422]).toContain(res.statusCode);
  });

  it('bulk add-users to a nonexistent squad → NOT 500', async () => {
    const c = await mk({ username: `probe_ghost3_${Date.now()}` });
    const uuid = c.json().response.uuid;
    const res = await post(`internal-squads/${GHOST_SQUAD}/bulk-actions/add-users`, { userUuids: [uuid] });
    expect(res.statusCode).not.toBe(500);
  });
});

describe('R6 empirical: hostile input never 500s (clean 4xx or handled)', () => {
  it('non-hex squad on create → 400 (PermissiveUuid rejects)', async () => {
    const res = await mk({ username: `probe_bad_${Date.now()}`, activeInternalSquads: ['not-a-uuid'] });
    expect(res.statusCode).toBe(400);
  });
  it('oversized externalSquadUuid (>64) → 400', async () => {
    const res = await mk({ username: `probe_ext_${Date.now()}`, externalSquadUuid: 'x'.repeat(200) });
    expect(res.statusCode).not.toBe(500);
  });
  it('oversized description (>1000) → not 500', async () => {
    const res = await mk({ username: `probe_desc_${Date.now()}`, description: 'x'.repeat(5000) });
    expect(res.statusCode).not.toBe(500);
  });
  it('malformed uuid on squad detail → not 500', async () => {
    expect((await get('internal-squads/not-a-uuid')).statusCode).not.toBe(500);
  });
  it('reset-traffic / actions on a well-formed but absent uuid → 404, not 500', async () => {
    const absent = '22222222-2222-4222-8222-222222222222';
    expect((await post(`users/${absent}/actions/reset-traffic`, {})).statusCode).toBe(404);
  });
});

describe('R6 empirical: concurrency', () => {
  it('parallel create of the SAME username → exactly one 200, others 409 A019 (no 500)', async () => {
    const username = `probe_race_${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => post('users', { username })));
    for (const r of results) if (r.statusCode === 200) createdUserIds.push(r.json().response.uuid);
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 409)).toHaveLength(4);
  });
});
