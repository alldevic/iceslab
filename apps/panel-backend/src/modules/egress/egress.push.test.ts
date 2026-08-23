import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { fetchEnabledInbounds } from '../inbounds/inbounds.queue.js';
import { updateNode } from '../nodes/nodes.service.js';
import { UpdateNodeSchema } from '../nodes/nodes.schemas.js';
import { eventBus } from '../../lib/event-bus.js';
import type { RoutingFragmentsCfg } from '@iceslab/shared';

/**
 * B1 delivery, not compilation: the compiler is covered in egress.policy.test.
 * What this asserts is that an authored policy actually REACHES the node, and
 * that a rule naming a channel the node does not have never does. A policy the
 * panel shows but never pushes is the failure mode worth a database round-trip.
 */

let seq = 0;

async function node(hardening: unknown, warp?: { enabled: boolean }): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `n-${seq}`,
      address: `n-${seq}.test:1337`,
      // Required (Bytes, normally minted by the node service); never read here.
      heartbeatSecret: Buffer.alloc(32),
      hardening: hardening as never,
      warpEnabled: warp?.enabled ?? false,
      warpAccount: warp?.enabled
        ? ({ secretKey: 'sk', address: ['172.16.0.2/32'] } as never)
        : undefined,
    },
  });
  return n.id;
}

async function bindXray(nodeId: string): Promise<void> {
  seq += 1;
  const profile = await prisma.profile.create({
    data: {
      name: `p-${seq}`,
      protocol: 'xray',
      config: { realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', realityServerNames: ['a.example'] } as never,
    },
  });
  await prisma.profileNodeBinding.create({
    data: { profileId: profile.id, nodeId, port: 443 },
  });
}

const RU_DIRECT = { egressPolicy: [{ geosite: ['ru'], target: 'direct' }] };

async function fragmentsOn(nodeId: string): Promise<RoutingFragmentsCfg | undefined> {
  const inbounds = await fetchEnabledInbounds(nodeId);
  const xray = inbounds.find((i) => i.protocol === 'xray');
  return (xray?.config as { routingFragments?: RoutingFragmentsCfg } | undefined)?.routingFragments;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('egress policy on the pushed inbound', () => {
  it('reaches the node xray config', async () => {
    const id = await node(RU_DIRECT);
    await bindXray(id);
    expect(await fragmentsOn(id)).toEqual({
      rules: [{ domain: ['geosite:ru'], outboundTag: 'direct' }],
    });
  });

  it('is absent when the node has no policy, so the wire stays as before', async () => {
    const id = await node({ ufwLockdown: true });
    await bindXray(id);
    expect(await fragmentsOn(id)).toBeUndefined();
  });

  // The rule targets a channel this node does not run. Pushing it would hand
  // xray an outboundTag no outbound answers, which it refuses to start on.
  it('drops a rule whose channel this node lacks, and pushes nothing when none survive', async () => {
    const id = await node({ egressPolicy: [{ geosite: ['youtube'], target: 'warp' }] });
    await bindXray(id);
    expect(await fragmentsOn(id)).toBeUndefined();
  });

  it('keeps that same rule on a node that does have the channel', async () => {
    const id = await node({ egressPolicy: [{ geosite: ['youtube'], target: 'warp' }] }, {
      enabled: true,
    });
    await bindXray(id);
    expect(await fragmentsOn(id)).toEqual({
      rules: [{ domain: ['geosite:youtube'], outboundTag: 'warp' }],
    });
  });
});

// A push only happens when something tells the worker to push. Editing a split
// is normally the ONLY change in that request, so if the policy is not one of
// the fields that re-push, the operator saves it, the panel shows it, and the
// node goes on routing the old way until an unrelated edit happens by.
describe('editing the policy re-pushes the node config', () => {
  // The bus has no unsubscribe, so one listener for the file and a cleared
  // buffer per case. Handlers run in a microtask, hence the drain before the
  // assertion.
  const emitted: string[] = [];
  eventBus.on('node.updated', ({ nodeId }) => emitted.push(nodeId));
  const drain = () => new Promise((resolve) => setImmediate(resolve));

  it('emits node.updated when the policy changes', async () => {
    const id = await node({ ufwLockdown: true });
    emitted.length = 0;
    await updateNode(id, UpdateNodeSchema.parse({ hardening: { ufwLockdown: true, ...RU_DIRECT } }));
    await drain();
    expect(emitted).toEqual([id]);
  });

  it('emits node.updated when the zapret2 channel changes', async () => {
    const id = await node({ zapret2: { enabled: false } });
    emitted.length = 0;
    await updateNode(id, UpdateNodeSchema.parse({ hardening: { zapret2: { enabled: true } } }));
    await drain();
    expect(emitted).toEqual([id]);
  });

  it('stays quiet when an unrelated hardening toggle changes', async () => {
    const id = await node({ ufwLockdown: true, ...RU_DIRECT });
    emitted.length = 0;
    await updateNode(id, UpdateNodeSchema.parse({ hardening: { fail2ban: true, ...RU_DIRECT } }));
    await drain();
    expect(emitted).toEqual([]);
  });
});

// B2a end to end through the database: the channel config on the node decides
// whether a rule naming it survives the compile.
describe('the zapret2 channel on the pushed inbound', () => {
  const YOUTUBE_VIA_ZAPRET2 = {
    egressPolicy: [{ geosite: ['youtube'], target: 'zapret2' }],
  };

  it('compiles the socks outbound when the node runs the channel', async () => {
    const id = await node({ ...YOUTUBE_VIA_ZAPRET2, zapret2: { enabled: true, socksPort: 1085 } });
    await bindXray(id);
    expect(await fragmentsOn(id)).toEqual({
      rules: [{ domain: ['geosite:youtube'], outboundTag: 'ext-zapret2' }],
      outbounds: [
        {
          tag: 'ext-zapret2',
          protocol: 'socks',
          settings: { servers: [{ address: '127.0.0.1', port: 1085 }] },
        },
      ],
    });
  });

  // The stack is torn down when disabled, so its port stops answering; a rule
  // left pointing there would black-hole exactly the blocked destinations the
  // operator added it for.
  it('drops the rule when the channel is switched off', async () => {
    const id = await node({ ...YOUTUBE_VIA_ZAPRET2, zapret2: { enabled: false } });
    await bindXray(id);
    expect(await fragmentsOn(id)).toBeUndefined();
  });
});
