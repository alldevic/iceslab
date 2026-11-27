import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { markExitsIpv6 } from './subscription.exit-ipv6.js';
import { getCachedBindings, _resetBindingsCacheForTest } from './subscription.bindings-cache.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * 18.7: the flag of a point is the fact of the node it leaves by: its own, and
 * for the entry of a cascade the exits' (not the entry's). Read after the
 * cached binding set, so a poll or a mode change shows at once.
 */
const v6 = (egress: boolean) => ({ observedAt: new Date().toISOString(), cores: [], ipv6: { stack: true, global: true, addresses: ['2001:db8::1'], egress } });

async function node(name: string, cores?: unknown, ipv6Mode = 'auto'): Promise<string> {
  const n = await prisma.node.create({
    data: { name, address: `${name}.example.com:1337`, protocol: 'xray', heartbeatSecret: randomBytes(32), ipv6Mode, ...(cores ? { cores: cores as never } : {}) },
    select: { id: true },
  });
  return n.id;
}
const point = (nodeId: string, extra: Partial<SubscriptionEndpoint> = {}) =>
  ({ protocol: 'xray', nodeId, nodeName: nodeId, host: 'h', port: 443, uri: '', ...extra }) as SubscriptionEndpoint;

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('markExitsIpv6', () => {
  it('a plain point takes its own node\'s fact under the node\'s mode', async () => {
    const on = await node('on', v6(true));
    const off = await node('off', v6(true), 'off');
    const bare = await node('bare');
    const eps = [point(on), point(off), point(bare)];
    await markExitsIpv6(eps, () => false);
    expect(eps.map((e) => e.exitHasIpv6)).toEqual([true, undefined, undefined]);
  });

  async function cascadeOf(entry: string, exits: string[][]) {
    const c = await prisma.cascade.create({ data: { name: `c-${randomBytes(3).toString('hex')}`, enabled: true, mode: 'chain' }, select: { id: true } });
    await prisma.cascadePosition.create({ data: { cascadeId: c.id, position: 0, nodes: { create: [{ nodeId: entry }] } } });
    for (const [i, nodeIds] of exits.entries()) {
      await prisma.cascadeDirection.create({ data: { cascadeId: c.id, tag: i + 1, nodes: { create: nodeIds.map((nodeId) => ({ nodeId })) } } });
    }
  }

  it('the entry of a cascade gets the fact of its exits, not its own', async () => {
    const entryV6 = await node('entry-v6', v6(true));
    const exitV4 = await node('exit-v4', v6(false));
    await cascadeOf(entryV6, [[exitV4]]);
    const eps = [point(entryV6)];
    await markExitsIpv6(eps, () => true);
    expect(eps[0]!.exitHasIpv6).toBeUndefined();
  });

  it('a cascade entry whose exit has IPv6 has it, though its own node does not', async () => {
    const entryV4 = await node('entry-v4', v6(false));
    const a = await node('exit-a', v6(false));
    const b = await node('exit-b', v6(true));
    await cascadeOf(entryV4, [[a], [b]]);
    const eps = [point(entryV4), point(a)];
    await markExitsIpv6(eps, (e) => e.nodeId === entryV4);
    expect(eps.map((e) => e.exitHasIpv6)).toEqual([true, undefined]);
  });

  it('a chained point with no cascade found has no IPv6', async () => {
    const lone = await node('lone', v6(true));
    const eps = [point(lone)];
    await markExitsIpv6(eps, () => true);
    expect(eps[0]!.exitHasIpv6).toBeUndefined();
  });

  it('follows a poll and a mode change though the binding set stays cached', async () => {
    _resetBindingsCacheForTest();
    const n = await node('n', v6(false));
    const cached = await getCachedBindings('k', Date.now(), async () => [point(n)]);
    const flag = async () => {
      const eps = [...cached].map((e) => ({ ...e }));
      await markExitsIpv6(eps, () => false);
      return eps[0]!.exitHasIpv6 === true;
    };
    expect(await flag()).toBe(false);
    await prisma.node.update({ where: { id: n }, data: { cores: v6(true) as never } });
    expect(await getCachedBindings('k', Date.now(), async () => [])).toBe(cached);
    expect(await flag()).toBe(true);
    await prisma.node.update({ where: { id: n }, data: { ipv6Mode: 'off' } });
    expect(await flag()).toBe(false);
  });
});
