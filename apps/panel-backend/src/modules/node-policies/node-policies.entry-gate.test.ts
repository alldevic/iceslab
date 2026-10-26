import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { explainPolicyForNode } from './node-policies.service.js';
import { applyInboundsRequestForNode } from '../inbounds/inbounds.queue.js';

/**
 * A-277, the stand 26.10: a user of a squad the cascade was switched off for
 * went out through the cascade's SE exit, because the node policy's rule
 * "ifconfig.me -> direction SE" sat above the doors with no user. The rule now
 * carries the users the door of SE lets through, from the doors' own gate.
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
      cores: { observedAt: new Date().toISOString(), cores: [{ name: 'xray', engine: 'xray' }] } as unknown as object,
    },
    select: { id: true },
  });
  return n.id;
}

/** A cascade ru -> NL | SE, a vless host on the entry, and a node policy on
 *  the entry with "ifconfig.me -> SE". */
async function stand(entryProtocol = 'xray') {
  const ru = await node('ru-entry', 'RU');
  const nl = await node('nl-exit', 'NL');
  const se = await node('se-exit', 'SE');
  const c = await post('/api/cascades', {
    name: `c-${randomBytes(2).toString('hex')}`,
    enabled: true,
    positions: [{ position: 0, nodeIds: [ru], entryProtocol: 'xray', linkProtocol: 'vless' }],
    directions: [
      { countryCode: 'NL', nodeIds: [nl] },
      { countryCode: 'SE', nodeIds: [se] },
    ],
  });
  const cascadeId = c.id as string;
  const dirs = await prisma.cascadeDirection.findMany({ where: { cascadeId }, orderBy: { tag: 'asc' } });
  const seDir = dirs[1]!;
  const profile = await post('/api/profiles', { name: 'entry-vless', protocol: 'xray', config: VLESS });
  await post('/api/hosts', { profileId: profile.id, nodeId: ru, port: 443 });
  const policy = await prisma.nodePolicy.create({
    data: {
      name: 'cascade-test',
      rules: {
        create: [{ position: 0, matchDomain: ['ifconfig.me'], matchIp: [], matchProtocol: [], actionKind: 'cascade', direction: { connect: { id: seDir.id } } }],
      },
    },
    include: { rules: true },
  });
  await prisma.node.update({ where: { id: ru }, data: { policyId: policy.id } });
  if (entryProtocol !== 'xray') {
    await prisma.cascadePosition.updateMany({ where: { cascadeId, position: 0 }, data: { entryProtocol } });
  }
  return { ru, cascadeId, nlDir: dirs[0]!, seDir, profileId: profile.id as string, ruleId: policy.rules[0]!.id };
}

const cascadeAction = (p: Awaited<ReturnType<typeof explainPolicyForNode>>) =>
  p.policy?.rules.find((r) => r.action.kind === 'cascade')?.action as { kind: 'cascade'; exit: string; users?: string[] } | undefined;

describe('a node policy rule into a cascade direction', () => {
  it('lists the users the door lets through: not the squad it is switched off for, not one narrowed elsewhere', async () => {
    const { ru, cascadeId, nlDir, profileId } = await stand();
    const off = await post('/api/squads', { name: 'off', profileIds: [profileId], exitAcl: [{ cascadeId, directionIds: [] }] });
    const narrow = await post('/api/squads', { name: 'nl-only', profileIds: [profileId], exitAcl: [{ cascadeId, directionIds: [nlDir.id] }] });
    const open = await post('/api/squads', { name: 'open', profileIds: [profileId] });
    const offUser = await post('/api/users', { username: 'u_off', groupIds: [off.id] });
    const nlUser = await post('/api/users', { username: 'u_nl', groupIds: [narrow.id] });
    const openUser = await post('/api/users', { username: 'u_open', groupIds: [open.id] });

    const explained = await explainPolicyForNode(ru);
    expect(cascadeAction(explained)?.users).toEqual([openUser.id]);
    expect(explained.notDrawn).toEqual([]);
    expect(explained.ungated).toEqual([]);
    // What the node is pushed carries the same list.
    const req = await applyInboundsRequestForNode(ru);
    const pushed = req?.policy?.rules.find((r) => r.action.kind === 'cascade')?.action as { users?: string[] } | undefined;
    expect(pushed?.users).toEqual([openUser.id]);
    expect(pushed?.users).not.toContain(offUser.id);
    expect(pushed?.users).not.toContain(nlUser.id);
  });

  it('every user of the entry may take it: no list, as before', async () => {
    const { ru, profileId } = await stand();
    const open = await post('/api/squads', { name: 'open', profileIds: [profileId] });
    await post('/api/users', { username: 'u_a', groupIds: [open.id] });
    await post('/api/users', { username: 'u_b', groupIds: [open.id] });
    const action = cascadeAction(await explainPolicyForNode(ru));
    expect(action).toBeDefined();
    expect(action!.users).toBeUndefined();
  });

  it('nobody may take it: the rule is left out, never sent with an empty list', async () => {
    const { ru, cascadeId, profileId, ruleId } = await stand();
    const off = await post('/api/squads', { name: 'off', profileIds: [profileId], exitAcl: [{ cascadeId, directionIds: [] }] });
    await post('/api/users', { username: 'u_off', groupIds: [off.id] });
    const explained = await explainPolicyForNode(ru);
    expect(cascadeAction(explained)).toBeUndefined();
    expect(explained.notDrawn).toEqual([{ ruleId, reason: 'nobody-may-take' }]);
  });

  it('an entry through the chain (hysteria) cannot tell its users apart: drawn for all and said so', async () => {
    const { ru, profileId, ruleId } = await stand('hysteria');
    const open = await post('/api/squads', { name: 'open', profileIds: [profileId] });
    await post('/api/users', { username: 'u_a', groupIds: [open.id] });
    const explained = await explainPolicyForNode(ru, 'handover');
    expect(explained.ungated).toEqual([ruleId]);
    const action = cascadeAction(explained);
    if (action) expect(action.users).toBeUndefined();
  });
});
