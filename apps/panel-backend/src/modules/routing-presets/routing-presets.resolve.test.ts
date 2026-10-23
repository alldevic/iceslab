import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { generateSubscription } from '../subscription/subscription.service.js';
import { presetOf, resolveSquadPreset, type PresetColumns } from './routing-presets.resolve.js';

/**
 * A-229 part 3: the subscription and the user card read the own preset too,
 * in the order R3 set: user, then the squads' single distinct preset, then the
 * panel default.
 */

const own = (id: string, name = id): PresetColumns => ({
  routingPreset: null,
  customRoutingPreset: { id, name, rules: [{ match: ['geosite:google'], action: 'direct', note: '' }] },
});
const builtin = (key: string | null): PresetColumns => ({ routingPreset: key, customRoutingPreset: null });

describe('resolveSquadPreset', () => {
  it('one distinct preset wins, of either kind', () => {
    expect(resolveSquadPreset([builtin(null), builtin('ru-split')]).preset).toEqual({ kind: 'builtin', id: 'ru-split' });
    expect(resolveSquadPreset([builtin(null), own('p1'), own('p1')]).preset).toMatchObject({ kind: 'custom', id: 'p1' });
  });

  it('a built-in in one squad and an own preset in another are two: the panel default, and a conflict', () => {
    expect(resolveSquadPreset([builtin('ru-split'), own('p1')])).toEqual({ preset: null, conflict: true });
    expect(resolveSquadPreset([own('p1'), own('p2')])).toEqual({ preset: null, conflict: true });
  });

  it('nothing set is null without a conflict, and a key the code does not know is ignored', () => {
    expect(resolveSquadPreset([builtin(null), builtin('garbage')])).toEqual({ preset: null, conflict: false });
    expect(presetOf(builtin('garbage'))).toBeNull();
  });
});

describe('through the subscription and the user card', () => {
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

  async function preset(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/api/routing-presets', headers: auth(),
      payload: { name, rules: [{ match: ['geoip:private'], action: 'direct' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  async function squad(name: string, payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/squads', headers: auth(), payload: { name, ...payload } });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).id as string;
  }

  async function user(payload: Record<string, unknown>): Promise<{ id: string; sub: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload });
    expect(res.statusCode, res.body).toBe(201);
    const id = JSON.parse(res.body).id as string;
    const { subscriptionToken } = await prisma.user.findUniqueOrThrow({ where: { id }, select: { subscriptionToken: true } });
    return { id, sub: subscriptionToken };
  }

  async function card(id: string) {
    const res = await app.inject({ method: 'GET', url: `/api/users/${id}/delivery`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { routing: Record<string, unknown> }).routing;
  }

  it('the user\'s own preset is what the subscription resolves, and the card says so', async () => {
    const p = await preset('office');
    const u = await user({ username: 'own-user', customRoutingPresetId: p });
    const result = await generateSubscription(u.sub, { ip: '127.0.0.1', userAgent: '' });
    expect(result.userPreset).toMatchObject({ kind: 'custom', id: p, name: 'office', rules: [{ match: ['geoip:private'] }] });

    expect(await card(u.id)).toMatchObject({
      source: 'user',
      effectivePreset: { builtIn: false, id: p, name: 'office' },
      userPreset: { builtIn: false, id: p },
      user: null,
    });
  });

  it('the own preset\'s rules are what xray-json, Clash and sing-box carry for that user (A-229 part 4)', async () => {
    const p = await preset('office');
    const u = await user({ username: 'served-own', customRoutingPresetId: p });
    const xray = await app.inject({ method: 'GET', url: `/sub/${u.sub}?format=xrayjson` });
    expect(xray.statusCode).toBe(200);
    expect(xray.body.replace(/\s+/g, '')).toContain('"ip":["geoip:private"],"outboundTag":"direct"');
    expect(xray.body).not.toContain('geosite:category-ru');
    const clash = await app.inject({ method: 'GET', url: `/sub/${u.sub}?format=clash` });
    expect(clash.body).toContain('  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
    const sb = await app.inject({ method: 'GET', url: `/sub/${u.sub}?format=singbox` });
    expect(sb.body).toContain('"ip_is_private": true');
    // ?routing= on the request still wins over the user's own preset.
    const forced = await app.inject({ method: 'GET', url: `/sub/${u.sub}?format=xrayjson&routing=ru-split` });
    expect(forced.body).toContain('geosite:category-ru');
  });

  it('a squad\'s own preset reaches its members; the user\'s built-in still wins over it', async () => {
    const p = await preset('squad-rules');
    const s = await squad('with-own', { customRoutingPresetId: p });
    const member = await user({ username: 'member', groupIds: [s] });
    const fromSquad = await generateSubscription(member.sub, { ip: '127.0.0.1', userAgent: '' });
    expect(fromSquad.squadPreset).toMatchObject({ kind: 'custom', id: p });
    expect(fromSquad.userPreset).toBeNull();
    expect(await card(member.id)).toMatchObject({ source: 'squad', effectivePreset: { id: p } });

    const overriding = await user({ username: 'overriding', groupIds: [s], routingPreset: 'cn-split' });
    expect(await card(overriding.id)).toMatchObject({
      source: 'user',
      effective: 'cn-split',
      effectivePreset: { builtIn: true, id: 'cn-split' },
    });
  });

  it('a built-in in one squad and an own preset in another fall to the panel default, as two built-ins do', async () => {
    const p = await preset('other');
    const a = await squad('builtin-sq', { routingPreset: 'ru-split' });
    const b = await squad('own-sq', { customRoutingPresetId: p });
    const u = await user({ username: 'torn', groupIds: [a, b] });
    const result = await generateSubscription(u.sub, { ip: '127.0.0.1', userAgent: '' });
    expect(result.squadPreset).toBeNull();
    expect(await card(u.id)).toMatchObject({ source: 'global', squadConflict: true, squadPreset: null });
  });
});
