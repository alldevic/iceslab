import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { getChainForNode } from './cascade.service.js';
import { routeTag } from './cascade.config.js';

/**
 * A-134 end to end on the panel side: a squad narrowed to one direction of a
 * cascade, and the entry the node is pushed lists who may take the other
 * direction's tag, with the trap behind it. And the narrowing is refused for a
 * cascade entered through hysteria or AmneziaWG, where the node cannot keep it.
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
async function post(url: string, payload: unknown, expected = 201) {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  expect(res.statusCode, res.body).toBe(expected);
  return JSON.parse(res.body);
}

const VLESS = {
  security: 'reality',
  realityDest: 'www.microsoft.com:443',
  realityServerNames: ['www.microsoft.com'],
  realityPrivateKey: 'k'.repeat(43),
  realityPublicKey: 'p'.repeat(43),
  realityShortIds: ['0123abcd'],
  network: 'raw',
};

async function node(name: string, country: string): Promise<string> {
  const n = await prisma.node.create({
    data: {
      name,
      address: `${name}.example.com`,
      protocol: 'xray',
      countryCode: country,
      heartbeatSecret: randomBytes(32),
      cores: {
        observedAt: new Date().toISOString(),
        cores: [
          { name: 'xray', engine: 'xray' },
          { name: 'tuic', engine: 'singbox' },
        ],
      } as unknown as object,
    },
    select: { id: true },
  });
  return n.id;
}

async function cascade(entryProtocol: string) {
  const ru = await node('ru-entry', 'RU');
  const nl = await node('nl-exit', 'NL');
  const se = await node('se-exit', 'SE');
  const c = await post('/api/cascades', {
    name: `c-${randomBytes(2).toString('hex')}`,
    enabled: true,
    positions: [{ position: 0, nodeIds: [ru], entryProtocol, linkProtocol: 'vless' }],
    directions: [
      { countryCode: 'NL', nodeIds: [nl] },
      { countryCode: 'SE', nodeIds: [se] },
    ],
  });
  const dirs = await prisma.cascadeDirection.findMany({ where: { cascadeId: c.id }, orderBy: { tag: 'asc' } });
  return { ru, cascadeId: c.id as string, nlDir: dirs[0]!, seDir: dirs[1]! };
}

describe('the entry gate as the node gets it', () => {
  it('a squad narrowed to NL is not listed on the SE tag, the trap holds that tag, an open squad is', async () => {
    const { ru, cascadeId, nlDir, seDir } = await cascade('xray');
    const profile = await post('/api/profiles', { name: 'entry-vless', protocol: 'xray', config: VLESS });
    await post('/api/hosts', { profileId: profile.id, nodeId: ru, port: 443 });
    const narrow = await post('/api/squads', { name: 'nl-only', profileIds: [profile.id], exitAcl: [{ cascadeId, directionIds: [nlDir.id] }] });
    const open = await post('/api/squads', { name: 'open', profileIds: [profile.id] });
    const nlUser = await post('/api/users', { username: 'gate_nl', groupIds: [narrow.id] });
    const allUser = await post('/api/users', { username: 'gate_all', groupIds: [open.id] });

    const chain = await getChainForNode(ru);
    const rules = (chain?.userCore as { fragments?: { routingRules: Record<string, unknown>[] } } | undefined)?.fragments
      ?.routingRules;
    expect(rules, JSON.stringify(chain?.userCore)).toBeDefined();
    const seTag = String(routeTag(0, seDir.tag - 1));
    const nlTag = String(routeTag(0, nlDir.tag - 1));
    const onSe = rules!.filter((r) => String(r.vlessRoute).split(',').includes(seTag) && r.outboundTag !== 'blocked');
    expect(onSe.length, JSON.stringify({ rules, nl: nlUser.id, all: allUser.id })).toBeGreaterThan(0);
    expect(onSe.every((r) => Array.isArray(r.user)), JSON.stringify({ rules, nl: nlUser.id, all: allUser.id })).toBe(true);
    for (const r of onSe) {
      expect(r.user).toContain(allUser.id);
      expect(r.user).not.toContain(nlUser.id);
    }
    // NL is open to both: drawn without a list.
    const onNl = rules!.filter((r) => String(r.vlessRoute).split(',').includes(nlTag) && r.outboundTag !== 'blocked');
    expect(onNl.some((r) => r.user === undefined)).toBe(true);
    // And the trap behind them.
    expect(rules!.at(-1)).toMatchObject({ outboundTag: 'blocked' });
    expect(String(rules!.at(-1)!.vlessRoute).split(',')).toContain(seTag);
  });
});

describe('narrowing a cascade entered through the chain', () => {
  it.each(['hysteria', 'amneziawg'])('is refused for a %s entry, and switching it off is not', async (entryProtocol) => {
    const { cascadeId, nlDir } = await cascade('xray');
    await prisma.cascadePosition.updateMany({ where: { cascadeId, position: 0 }, data: { entryProtocol } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/squads',
      headers: auth(),
      payload: { name: 'narrow', exitAcl: [{ cascadeId, directionIds: [nlDir.id] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain(entryProtocol);
    await post('/api/squads', { name: 'off', exitAcl: [{ cascadeId, directionIds: [] }] });
  });
});
