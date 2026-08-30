import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { fetchEnabledInbounds } from './inbounds.queue.js';

/**
 * Three features are per-NODE, not per-profile — WARP egress, the compiled
 * egress policy, and a cascade hop — and all three are delivered by hanging a
 * key on an xray inbound's config at push time. All three render as xray
 * routing rules and outbounds, and the sing-box renderer emits neither: its
 * outbound list is exactly `[{"type":"direct"}]`.
 *
 * So handing one to an inbound the sing-box engine serves has two outcomes and
 * both are wrong. Cascade and routingFragments the agent refuses, which fails
 * the push for every OTHER inbound on that node too. WARP it had no guard for
 * on either side, and that is the one measured on a lab node 2026-08-30: the
 * panel showed the node with WARP egress enabled, the rendered sing-box config
 * held one `direct` outbound, and every flow left the node's own address while
 * the panel said otherwise.
 *
 * The fix is not a third guard, it is asking once WHICH xray inbound may carry
 * these — and a node with no such inbound gets the "nowhere to render" log the
 * egress policy already had.
 */

let seq = 0;

async function makeNode(opts: { warp?: boolean; egressPolicy?: unknown } = {}): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `n-${seq}`,
      address: `n-${seq}.test:1337`,
      // Required (Bytes, normally minted by the node service); never read here.
      heartbeatSecret: Buffer.alloc(32),
      hardening: (opts.egressPolicy ? { egressPolicy: opts.egressPolicy } : {}) as never,
      warpEnabled: opts.warp ?? false,
      warpAccount: opts.warp
        ? ({ secretKey: 'sk', address: ['172.16.0.2/32'] } as never)
        : undefined,
    },
  });
  return n.id;
}

/** Bind an xray profile served by `engine` (null = the native xray core). */
async function bindXray(nodeId: string, engine: 'singbox' | null, port = 443): Promise<void> {
  seq += 1;
  const profile = await prisma.profile.create({
    data: {
      name: `p-${seq}`,
      protocol: 'xray',
      engine,
      config: {
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        realityServerNames: ['a.example'],
        realityShortIds: ['0123abcd'],
      } as never,
    },
  });
  await prisma.profileNodeBinding.create({ data: { profileId: profile.id, nodeId, port } });
}

type Cfg = Record<string, unknown>;

/** The config of the inbound served by `engine`, as it goes on the wire. */
async function cfgFor(nodeId: string, engine: 'singbox' | undefined): Promise<Cfg> {
  const inbounds = await fetchEnabledInbounds(nodeId);
  const ib = inbounds.find((i) => i.protocol === 'xray' && i.engine === engine);
  if (!ib) throw new Error(`no xray inbound with engine=${engine}: ${JSON.stringify(inbounds)}`);
  return ib.config as unknown as Cfg;
}

const RU_DIRECT = [{ geosite: ['ru'], target: 'direct' }];

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('per-node features against the engine that would render them', () => {
  it('does not hand WARP to an inbound the sing-box engine serves', async () => {
    const id = await makeNode({ warp: true });
    await bindXray(id, 'singbox');
    expect(
      (await cfgFor(id, 'singbox')).warp,
      'the sing-box renderer emits only a direct outbound, so this key becomes a promise the node cannot keep',
    ).toBeUndefined();
  });

  it('does not hand an egress policy to an inbound the sing-box engine serves', async () => {
    const id = await makeNode({ egressPolicy: RU_DIRECT });
    await bindXray(id, 'singbox');
    expect((await cfgFor(id, 'singbox')).routingFragments).toBeUndefined();
  });

  // The reverse direction. Without it, "not attached" is indistinguishable from
  // "never attached to anything", and this test would pass over a queue that
  // had simply stopped delivering WARP.
  it('still hands both to an inbound the xray engine serves', async () => {
    const id = await makeNode({ warp: true, egressPolicy: RU_DIRECT });
    await bindXray(id, null);
    const cfg = await cfgFor(id, undefined);
    expect(cfg.warp).toMatchObject({ secretKey: 'sk' });
    expect(cfg.routingFragments).toEqual({
      rules: [{ domain: ['geosite:ru'], outboundTag: 'direct' }],
    });
  });

  // A node can carry both. The one that can render them must get them, and it
  // must be chosen by what serves it rather than by which was created first —
  // the old code took the first xray inbound in the list either way.
  it('picks the xray-served inbound on a node that has both', async () => {
    const id = await makeNode({ warp: true, egressPolicy: RU_DIRECT });
    await bindXray(id, 'singbox', 443);
    await bindXray(id, null, 8443);

    expect((await cfgFor(id, 'singbox')).warp).toBeUndefined();
    expect((await cfgFor(id, 'singbox')).routingFragments).toBeUndefined();
    expect((await cfgFor(id, undefined)).warp).toMatchObject({ secretKey: 'sk' });
    expect((await cfgFor(id, undefined)).routingFragments).toBeDefined();
  });
});
