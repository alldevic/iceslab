import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/event-bus.js';
import { createCascade, getCascadeFragmentsForNode } from '../cascades/cascade.service.js';
import { repushEgressCascades } from './geo.cron.js';
import type { EgressPolicy } from '../cascades/cascade.geo.js';

let seq = 0;
async function node(name: string): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return n.id;
}

beforeEach(async () => {
  await cleanDatabase();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const GEOSITE_ONLY: EgressPolicy = [{ geosite: ['category-ru'], target: 'direct' }];
const GEOIP_POLICY: EgressPolicy = [{ geoip: ['ru'], target: 'direct' }];

describe('repushEgressCascades (§3.3)', () => {
  it('emits cascade.changed only for enabled cascades that carry an egress policy', async () => {
    const a1 = await node('a1');
    const a2 = await node('a2');
    const b1 = await node('b1');
    const c1 = await node('c1');

    // A: enabled + egress policy -> its nodes repush.
    await createCascade({
      name: 'with-policy',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: a1, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: a2, position: 1 },
      ],
      egressPolicy: GEOSITE_ONLY,
    });
    // B: enabled, no egress policy -> excluded.
    await createCascade({
      name: 'no-policy',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: b1, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: a2, position: 1 },
      ],
    });
    // C: has policy but DISABLED -> excluded.
    await createCascade({
      name: 'disabled',
      enabled: false,
      mode: 'chain',
      hops: [
        { nodeId: c1, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: a2, position: 1 },
      ],
      egressPolicy: GEOSITE_ONLY,
    });

    const spy = vi.spyOn(eventBus, 'emit');
    const count = await repushEgressCascades();

    const call = spy.mock.calls.find((c) => c[0] === 'cascade.changed');
    expect(call).toBeDefined();
    const nodeIds = (call![1] as { nodeIds: string[] }).nodeIds;
    expect(new Set(nodeIds)).toEqual(new Set([a1, a2])); // only cascade A's hops
    expect(nodeIds).not.toContain(b1);
    expect(nodeIds).not.toContain(c1);
    expect(count).toBe(2);
  });

  it('does not emit when no egress-policy cascades exist', async () => {
    const b1 = await node('b1');
    const b2 = await node('b2');
    await createCascade({
      name: 'plain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: b1, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: b2, position: 1 },
      ],
    });
    const spy = vi.spyOn(eventBus, 'emit');
    const count = await repushEgressCascades();
    expect(count).toBe(0);
    expect(spy.mock.calls.find((c) => c[0] === 'cascade.changed')).toBeUndefined();
  });
});

describe('IPOnDemand override reaches the entry fragments (§3.1 integration)', () => {
  it('sets domainStrategy=IPOnDemand on the entry when the policy has a geoip matcher', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    await createCascade({
      name: 'geoip-split',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
      egressPolicy: GEOIP_POLICY,
    });
    const frag = await getCascadeFragmentsForNode(entry);
    expect(frag?.domainStrategy).toBe('IPOnDemand');
  });

  it('leaves domainStrategy unset for a geosite-only policy (byte-identical default)', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    await createCascade({
      name: 'geosite-split',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
      egressPolicy: GEOSITE_ONLY,
    });
    const frag = await getCascadeFragmentsForNode(entry);
    expect(frag?.domainStrategy).toBeUndefined();
  });
});
