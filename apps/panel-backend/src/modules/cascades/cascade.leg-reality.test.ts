import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { stubNodeRoster } from '../../../tests/helpers/node-roster.js';
import { NodeRequestError, NodeTransport } from '../nodes/nodes.transport.js';
import { applyInboundsForNode } from '../inbounds/inbounds.queue.js';
import { createCascade, getCascadeFragmentsForNode } from './cascade.service.js';
import { giveRealityToPlainVless, parseLinkCred, type LinkCred } from './cascade.config.js';

/**
 * A-157: a vless leg stored before phase 5b has no REALITY block and was drawn
 * as open VLESS between the nodes until someone saved the cascade again. The
 * push gives it the block, on both ends, without an operator.
 */
let seq = 0;

async function node(name: string): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `10.9.0.${seq}:1337`,
      protocol: 'xray',
      status: 'online',
      heartbeatSecret: randomBytes(32),
    },
    select: { id: true },
  });
  return n.id;
}

const plainVless = (port = 24000): LinkCred => ({ protocol: 'vless', port, uuid: randomUUID() });

type Json = Record<string, unknown>;
const securityOf = (o: Json | undefined) => (o?.streamSettings as Json | undefined)?.security ?? 'none';

beforeEach(async () => {
  await cleanDatabase();
  vi.spyOn(NodeTransport.prototype, 'listAssets').mockRejectedValue(new NodeRequestError('404', 404, null));
  vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({ ok: true, applied: 0, skipped: 0 });
  stubNodeRoster();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('giveRealityToPlainVless', () => {
  it('gives one pair per receiving node, a short id per leg, and leaves the rest alone', () => {
    const ss: LinkCred = { protocol: 'shadowsocks', port: 24000, psk: 'k', method: '2022-blake3-aes-256-gcm' };
    const out = giveRealityToPlainVless([
      { to: 'a', cred: plainVless() },
      { to: 'a', cred: plainVless() },
      { to: 'b', cred: plainVless(24001) },
      { to: 'c', cred: ss },
    ])!;
    const [a1, a2, b] = out as Extract<LinkCred, { protocol: 'vless' }>[];
    expect(a1!.reality!.privateKey).toBe(a2!.reality!.privateKey);
    expect(a1!.reality!.shortId).not.toBe(a2!.reality!.shortId);
    expect(b!.reality!.privateKey).not.toBe(a1!.reality!.privateKey);
    expect(out[3]).toBe(ss);
  });

  it('keeps the pair a node already serves, and writes nothing when no leg is plain', () => {
    const served = giveRealityToPlainVless([{ to: 'a', cred: plainVless() }])![0]!;
    const out = giveRealityToPlainVless([
      { to: 'a', cred: served },
      { to: 'a', cred: plainVless() },
    ])!;
    expect(out[0]).toBe(served);
    expect((out[1] as Extract<LinkCred, { protocol: 'vless' }>).reality!.privateKey).toBe(
      (served as Extract<LinkCred, { protocol: 'vless' }>).reality!.privateKey,
    );
    expect(giveRealityToPlainVless([{ to: 'a', cred: served }])).toBeNull();
  });
});

describe('a legacy chain with a plain vless leg', () => {
  it('is drawn open before the push, with REALITY on both ends after it, and the other end is pushed', async () => {
    const entry = await node('ru');
    const exit = await node('nl');
    const c = await prisma.cascade.create({ data: { name: 'old-chain', enabled: true }, select: { id: true } });
    await prisma.cascadeHop.create({
      data: { cascadeId: c.id, nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'vless', linkConfig: plainVless() as never },
    });
    await prisma.cascadeHop.create({ data: { cascadeId: c.id, nodeId: exit, position: 1 } });

    // The finding as it stood: the leg out of the entry is open VLESS.
    const before = (await getCascadeFragmentsForNode(entry))!;
    const openLeg = before.outbounds.find((o) => String((o as Json).tag).startsWith('cascade-link-out')) as Json;
    expect(openLeg, 'the entry draws no leg out at all').toBeDefined();
    expect(securityOf(openLeg)).toBe('none');

    const emit = vi.spyOn(eventBus, 'emit');
    await applyInboundsForNode(entry);

    const hop = await prisma.cascadeHop.findFirstOrThrow({ where: { cascadeId: c.id, position: 0 } });
    const cred = parseLinkCred(hop.linkConfig) as Extract<LinkCred, { protocol: 'vless' }>;
    expect(cred.reality).toBeDefined();

    const out = (await getCascadeFragmentsForNode(entry))!.outbounds.find((o) =>
      String((o as Json).tag).startsWith('cascade-link-out'),
    ) as Json;
    const inb = (await getCascadeFragmentsForNode(exit))!.inbounds.find((i) => String((i as Json).tag).startsWith('cascade-link-in')) as Json;
    expect(securityOf(out)).toBe('reality');
    expect(securityOf(inb)).toBe('reality');
    const pub = ((out.streamSettings as Json).realitySettings as Json).publicKey;
    expect(pub).toBe(cred.reality!.publicKey);
    expect(((inb.streamSettings as Json).realitySettings as Json).privateKey).toBe(cred.reality!.privateKey);

    // The other end is queued: both ends change together or the leg breaks.
    expect(emit).toHaveBeenCalledWith('cascade.changed', { nodeIds: [exit] });

    // The next push finds nothing to do and keeps the same keys.
    emit.mockClear();
    await applyInboundsForNode(exit);
    const again = parseLinkCred((await prisma.cascadeHop.findFirstOrThrow({ where: { cascadeId: c.id, position: 0 } })).linkConfig);
    expect(again).toEqual(cred);
    expect(emit).not.toHaveBeenCalledWith('cascade.changed', expect.anything());
  });
});

describe('a v4 cascade whose links were stored without REALITY', () => {
  it('gets one pair per receiving node on the push', async () => {
    const entry = await node('ru');
    const nl = await node('nl');
    const se = await node('se');
    const c = await createCascade({
      name: 'v4-old',
      enabled: true,
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'vless' }],
      directions: [
        { tag: 1, countryCode: 'NL', nodeIds: [nl] },
        { tag: 2, countryCode: 'SE', nodeIds: [se] },
      ],
    } as never);
    // As a pre-5b save left them: the block stripped from every leg.
    for (const l of await prisma.cascadeLink.findMany({ where: { cascadeId: c.id } })) {
      const { reality: _r, ...plain } = l.config as Json;
      await prisma.cascadeLink.update({ where: { id: l.id }, data: { config: plain as never } });
    }

    await applyInboundsForNode(entry);

    const links = await prisma.cascadeLink.findMany({ where: { cascadeId: c.id } });
    expect(links.length).toBeGreaterThan(0);
    const keyOf = new Map<string, string>();
    for (const l of links) {
      const cred = parseLinkCred(l.config) as Extract<LinkCred, { protocol: 'vless' }>;
      expect(cred.reality, `leg to ${l.toNodeId} still plain`).toBeDefined();
      const k = keyOf.get(l.toNodeId);
      if (k) expect(cred.reality!.privateKey).toBe(k);
      else keyOf.set(l.toNodeId, cred.reality!.privateKey);
    }
    expect(new Set(keyOf.values()).size).toBe(keyOf.size);
  });
});
