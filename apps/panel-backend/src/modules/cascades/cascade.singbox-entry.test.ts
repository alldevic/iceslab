import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SINGBOX_ENTRY_PROTOCOLS } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { applyInboundsRequestForNode } from '../inbounds/inbounds.queue.js';
import { entriesSwitchedOff } from '../users/user-reach.js';
import { CHAIN_SOCKS_USER, chainSocksPort } from './chain.ports.js';
import { cascadeEntryGate, getHysteriaEntryLabels, getRouteProfilesByEntryNode } from './cascade.service.js';

/**
 * The four sing-box entries, 11.4: tuic, anytls, shadowtls, shadowsocks.
 *
 * Handed to the chain like a hysteria entry (Auto's listener), with the block
 * naming engine `singbox` AND the protocol, because every sing-box instance on
 * the node answers to that engine and the protocol is what tells the entry's
 * apart from the node's other sing-box profiles. The agent half is 11.5.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function makeNode(name: string, countryCode?: string): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name, address: `${name}-${seq}.test`, protocol: 'xray', ...(countryCode ? { countryCode } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function reportEngines(nodeId: string, engines: string[]) {
  await prisma.node.update({
    where: { id: nodeId },
    data: {
      cores: {
        observedAt: new Date().toISOString(),
        cores: engines.map((engine) => ({ name: engine, engine, running: true })),
      } as unknown as object,
    },
  });
}

function topology(entry: string, exit: string, entryProtocol: string, directions = 1) {
  return {
    positions: [{ position: 0, nodeIds: [entry], entryProtocol, linkProtocol: 'vless' }],
    directions: [
      { countryCode: 'NL', nodeIds: [exit] },
      ...(directions > 1 ? [{ countryCode: 'SE', nodeIds: [] as string[] }] : []),
    ].slice(0, directions),
  };
}

async function create(entry: string, exit: string, entryProtocol: string) {
  seq += 1;
  return app.inject({
    method: 'POST',
    url: '/api/cascades',
    headers: auth(),
    payload: { name: `ru-${seq}`, enabled: true, ...topology(entry, exit, entryProtocol) },
  });
}

describe.each([...SINGBOX_ENTRY_PROTOCOLS])('a %s entry', (protocol) => {
  it('is saved, and the entry gets a singbox block naming the protocol and the Auto listener', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    const res = await create(entry, exit, protocol);
    expect(res.statusCode, res.body).toBe(201);

    const req = (await applyInboundsRequestForNode(entry))!;
    expect(req.chain?.userCore).toEqual({
      engine: 'singbox',
      protocol,
      socks: { port: chainSocksPort(0), username: CHAIN_SOCKS_USER, password: req.chain!.socksPassword },
    });
    // The half of an xray entry is absent: the agent refuses mixed halves.
    expect(req.chain!.userCore).not.toHaveProperty('fragments');
    // Auto's listener exists even on a one-direction cascade.
    expect(req.chain!.socks.map((s) => s.tag)).toEqual([0, 1]);
  });

  it('gets no xray drawing of the cascade, in the node block or on an xray inbound', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    const p = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'reality-ru',
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
    });
    expect(p.statusCode, p.body).toBe(201);
    const b = await app.inject({
      method: 'POST',
      url: '/api/bindings',
      headers: auth(),
      payload: { profileId: JSON.parse(p.body).id, nodeId: entry, port: 443 },
    });
    expect(b.statusCode, b.body).toBe(201);
    expect((await create(entry, exit, protocol)).statusCode).toBe(201);

    const req = (await applyInboundsRequestForNode(entry))!;
    expect(req.cascade).toBeUndefined();
    const xray = (req.inbounds as { protocol: string; config: Record<string, unknown> }[]).find(
      (i) => i.protocol === 'xray',
    )!;
    expect(xray.config).not.toHaveProperty('cascade');
  });

  it('is refused on a node that reported its engines without sing-box (ENTRY_CANNOT_CHAIN)', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    await reportEngines(entry, ['xray']);
    const res = await create(entry, exit, protocol);
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ENTRY_CANNOT_CHAIN');
    expect(body.conflicts).toEqual([{ nodeName: 'ru-entry', engines: ['xray'] }]);
    expect(await prisma.cascade.count()).toBe(0);
  });

  it('is let through when sing-box is among the reported engines', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    await reportEngines(entry, ['singbox']);
    expect((await create(entry, exit, protocol)).statusCode).toBe(201);
  });

  it('asks before it takes xray users out of the cascade, and goes through on consent', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    const p = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(),
      payload: {
        name: 'reality-ru',
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
    });
    await app.inject({
      method: 'POST',
      url: '/api/bindings',
      headers: auth(),
      payload: { profileId: JSON.parse(p.body).id, nodeId: entry, port: 443 },
    });
    const c = JSON.parse((await create(entry, exit, 'xray')).body);

    const refused = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${c.id}`,
      headers: auth(),
      payload: topology(entry, exit, protocol),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const body = JSON.parse(refused.body);
    expect(body.error).toBe('ENTRY_CHANGE_DROPS_USERS');
    expect(body.from).toBe('xray');
    expect(body.to).toBe(protocol);
    expect(body.conflicts).toEqual([{ nodeName: 'ru-entry', profileName: 'reality-ru' }]);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/cascades/${c.id}`,
      headers: auth(),
      payload: { ...topology(entry, exit, protocol), confirmEntryChange: true },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const req = (await applyInboundsRequestForNode(entry))!;
    expect(req.chain?.userCore?.engine).toBe('singbox');
    expect(req.cascade).toBeUndefined();
  });

  it('is not a gated entry: its users arrive through the chain and are not told apart', async () => {
    const entry = await makeNode('ru-entry');
    const exit = await makeNode('nl-exit');
    const c = JSON.parse((await create(entry, exit, protocol)).body);
    expect(await cascadeEntryGate(entry, c.id)).toEqual({ kind: 'ungated' });
  });
});

describe('a singbox entry in the subscription', () => {
  async function cascadeOn(entryProtocol: string, directions: { cc: string; node: string }[]) {
    const entry = await prisma.node.create({
      data: { name: 'ru-01', address: 'ru-01.example.com:1337', protocol: 'xray', countryCode: 'RU', heartbeatSecret: Buffer.alloc(32, 1) },
      select: { id: true },
    });
    const c = await prisma.cascade.create({ data: { name: 'ru', enabled: true, mode: 'chain' }, select: { id: true } });
    await prisma.cascadePosition.create({
      data: { cascadeId: c.id, position: 0, entryProtocol, nodes: { create: [{ nodeId: entry.id }] } },
    });
    let tag = 0;
    for (const d of directions) {
      tag += 1;
      await prisma.cascadeDirection.create({
        data: { cascadeId: c.id, tag, countryCode: d.cc, nodes: { create: [{ nodeId: d.node }] } },
      });
    }
    return { entry: entry.id, cascadeId: c.id };
  }

  async function exitNode(name: string, cc: string) {
    return (
      await prisma.node.create({
        data: { name, address: `${name}.example.com:1337`, protocol: 'xray', countryCode: cc, heartbeatSecret: Buffer.alloc(32, 2) },
        select: { id: true },
      })
    ).id;
  }

  it.each([...SINGBOX_ENTRY_PROTOCOLS])('names the %s host after the cascade and draws no vless profiles', async (protocol) => {
    const nl = await exitNode('nl-01', 'NL');
    const { entry } = await cascadeOn(protocol, [{ cc: 'NL', node: nl }]);
    expect((await getRouteProfilesByEntryNode([entry])).get(entry) ?? []).toEqual([]);
    expect((await getHysteriaEntryLabels([entry], [], undefined, protocol)).get(entry)).toBe('🇳🇱 ru → NL');
    // Only for its own protocol: a hy2 host on this node is a plain one.
    expect((await getHysteriaEntryLabels([entry])).has(entry)).toBe(false);
  });

  it('names the host with the Auto line when the chain chooses among several exits', async () => {
    const nl = await exitNode('nl-01', 'NL');
    const se = await exitNode('se-01', 'SE');
    const { entry } = await cascadeOn('tuic', [
      { cc: 'NL', node: nl },
      { cc: 'SE', node: se },
    ]);
    expect((await getHysteriaEntryLabels([entry], [], undefined, 'tuic')).get(entry)).toBe('⚡ ru → Auto');
  });

  it('gives a squad that switched the cascade off neither the label nor the inbound', async () => {
    const nl = await exitNode('nl-01', 'NL');
    const { entry, cascadeId } = await cascadeOn('anytls', [{ cc: 'NL', node: nl }]);
    const group = await prisma.group.create({ data: { name: 'staff' }, select: { id: true } });
    await prisma.groupCascadeOff.create({ data: { groupId: group.id, cascadeId } });

    // A host under its own name would promise a direct server the node is not.
    expect((await getHysteriaEntryLabels([entry], [group.id], undefined, 'anytls')).has(entry)).toBe(false);
    expect((await entriesSwitchedOff([group.id])).get(group.id)).toEqual(new Set([`${entry}|anytls`]));
  });
});
