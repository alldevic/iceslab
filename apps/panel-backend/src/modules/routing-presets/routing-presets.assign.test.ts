import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { presetUpdateData } from './routing-presets.assign.js';

/**
 * A-229 part 1: a user or a squad holds at most one routing preset, a built-in
 * key or an own one. Refused both at once, a value on one side clears the
 * other, an absent key is no edit; the database says the same underneath.
 */
let app: FastifyInstance;
let token: string;

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
const MISSING = '7b0d1c1e-0000-4000-8000-000000000000';

async function ownPreset(name = 'own-1'): Promise<string> {
  const row = await prisma.routingPreset.create({
    data: { name, rules: [{ match: ['geosite:google'], action: 'direct', note: '' }] },
  });
  return row.id;
}

describe('presetUpdateData', () => {
  it('writes what was given, clears the other side on a value, leaves absent keys alone', () => {
    expect(presetUpdateData({})).toEqual({});
    expect(presetUpdateData({ routingPreset: 'ru-split' })).toEqual({ routingPreset: 'ru-split', customRoutingPresetId: null });
    expect(presetUpdateData({ customRoutingPresetId: 'x' })).toEqual({ customRoutingPresetId: 'x', routingPreset: null });
    expect(presetUpdateData({ routingPreset: null })).toEqual({ routingPreset: null });
    expect(presetUpdateData({ customRoutingPresetId: null })).toEqual({ customRoutingPresetId: null });
    expect(presetUpdateData({ routingPreset: null, customRoutingPresetId: 'x' })).toEqual({ routingPreset: null, customRoutingPresetId: 'x' });
  });
});

describe('a user', () => {
  it('refuses both presets at once, on create and on edit, in words', async () => {
    const own = await ownPreset();
    const create = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'both-1', routingPreset: 'ru-split', customRoutingPresetId: own },
    });
    expect(create.statusCode).toBe(400);
    expect(create.body).toContain('both set');

    const ok = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'both-2' } });
    const id = JSON.parse(ok.body).id as string;
    const edit = await app.inject({
      method: 'PUT', url: `/api/users/${id}`, headers: auth(),
      payload: { routingPreset: 'ru-split', customRoutingPresetId: own },
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.body).toContain('both set');
  });

  it('refuses an own preset that does not exist, with a code and the field', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'ghost-1', customRoutingPresetId: MISSING },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
  });

  it('a value on one side clears the other, null clears its own, an absent key keeps both', async () => {
    const own = await ownPreset();
    const created = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'swap-1', customRoutingPresetId: own },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    expect(JSON.parse(created.body)).toMatchObject({ customRoutingPresetId: own, routingPreset: null });

    const put = async (payload: Record<string, unknown>) => {
      const r = await app.inject({ method: 'PUT', url: `/api/users/${id}`, headers: auth(), payload });
      expect(r.statusCode, r.body).toBe(200);
      return JSON.parse(r.body) as { routingPreset: string | null; customRoutingPresetId: string | null };
    };

    expect(await put({ description: 'unrelated' })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: 'ru-split' })).toMatchObject({ routingPreset: 'ru-split', customRoutingPresetId: null });
    expect(await put({ customRoutingPresetId: own })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: null })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ customRoutingPresetId: null })).toMatchObject({ customRoutingPresetId: null, routingPreset: null });
  });
});

describe('a squad', () => {
  it('refuses both presets at once and an own preset that does not exist', async () => {
    const own = await ownPreset();
    const both = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-both', routingPreset: 'cn-split', customRoutingPresetId: own },
    });
    expect(both.statusCode).toBe(400);
    expect(both.body).toContain('both set');

    const ghost = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-ghost', customRoutingPresetId: MISSING },
    });
    expect(ghost.statusCode).toBe(400);
    expect(JSON.parse(ghost.body)).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
    expect(await prisma.group.count({ where: { name: 'sq-ghost' } })).toBe(0);
  });

  it('a value on one side clears the other, an absent key keeps both', async () => {
    const own = await ownPreset();
    const created = await app.inject({
      method: 'POST', url: '/api/squads', headers: auth(),
      payload: { name: 'sq-swap', routingPreset: 'ru-split' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;

    const put = async (payload: Record<string, unknown>) => {
      const r = await app.inject({ method: 'PUT', url: `/api/squads/${id}`, headers: auth(), payload });
      expect(r.statusCode, r.body).toBe(200);
      return JSON.parse(r.body) as { routingPreset: string | null; customRoutingPresetId: string | null };
    };

    expect(await put({ customRoutingPresetId: own })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ description: 'unrelated' })).toMatchObject({ customRoutingPresetId: own, routingPreset: null });
    expect(await put({ routingPreset: 'cn-split' })).toMatchObject({ routingPreset: 'cn-split', customRoutingPresetId: null });
  });
});

describe('a preset deleted between the check and the write', () => {
  // The check is passed by a stand-in that says the row exists; the write then
  // meets the database without it, as after a delete in between.
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  const passCheckOnce = () => {
    spy?.mockRestore();
    spy = vi.spyOn(prisma.routingPreset, 'findUnique').mockResolvedValueOnce({ id: MISSING } as never);
  };
  afterEach(() => vi.restoreAllMocks());

  it('is the same 400 ROUTING_PRESET_NOT_FOUND, not a 500, on every write of a user and a squad', async () => {
    const expectGone = (res: { statusCode: number; body: string }, what: string) => {
      // The stand-in answered the check, so this refusal came from the write.
      expect(spy!.mock.calls.length, `${what}: the check was not the stand-in`).toBe(1);
      expect(res.statusCode, `${what}: ${res.body}`).toBe(400);
      expect(JSON.parse(res.body), what).toMatchObject({ error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' });
    };

    passCheckOnce();
    expectGone(
      await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'race-1', customRoutingPresetId: MISSING } }),
      'user create',
    );

    const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { username: 'race-2' } });
    passCheckOnce();
    expectGone(
      await app.inject({ method: 'PUT', url: `/api/users/${JSON.parse(user.body).id}`, headers: auth(), payload: { customRoutingPresetId: MISSING } }),
      'user edit',
    );

    passCheckOnce();
    expectGone(
      await app.inject({ method: 'POST', url: '/api/squads', headers: auth(), payload: { name: 'race-sq', customRoutingPresetId: MISSING } }),
      'squad create',
    );

    const squad = await app.inject({ method: 'POST', url: '/api/squads', headers: auth(), payload: { name: 'race-sq-2' } });
    passCheckOnce();
    expectGone(
      await app.inject({ method: 'PUT', url: `/api/squads/${JSON.parse(squad.body).id}`, headers: auth(), payload: { customRoutingPresetId: MISSING } }),
      'squad edit',
    );
  });
});

describe('the database underneath', () => {
  it('refuses a row holding both, and the deletion of a preset in use', async () => {
    const own = await ownPreset();
    const user = await app.inject({
      method: 'POST', url: '/api/users', headers: auth(),
      payload: { username: 'db-1', customRoutingPresetId: own },
    });
    const id = JSON.parse(user.body).id as string;

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "users" SET "routing_preset" = 'ru-split' WHERE "id" = $1::uuid`, id),
    ).rejects.toThrow(/users_one_routing_preset/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "groups" SET "routing_preset" = 'ru-split', "custom_routing_preset_id" = $1::uuid WHERE "name" = 'All'`,
        own,
      ),
    ).rejects.toThrow(/groups_one_routing_preset/);
    await expect(prisma.routingPreset.delete({ where: { id: own } })).rejects.toThrow();
    expect(await prisma.routingPreset.count()).toBe(1);
  });
});
