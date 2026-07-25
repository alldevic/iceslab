import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  createCascade,
  updateCascade,
  getCascadeFragmentsForNode,
} from './cascade.service.js';
import type { EgressPolicy } from './cascade.geo.js';

// E - the entry-hop geo split persists through create/update and reaches the
// node's cascade fragments via getCascadeFragmentsForNode. Runs against the test
// DB (docker compose postgres-test).

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

const POLICY: EgressPolicy = [
  { geosite: ['category-ads-all'], target: 'block' },
  { geosite: ['category-ru'], geoip: ['ru'], target: 'direct' },
];

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('cascade egress policy (server-side geo split)', () => {
  it('persists the policy and returns it on the DTO', async () => {
    const ru = await node('ru');
    const de = await node('de');
    const dto = await createCascade({
      name: 'geo-chain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: ru, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: de, position: 1 },
      ],
      egressPolicy: POLICY,
    });
    expect(dto.egressPolicy).toEqual(POLICY);
  });

  it('injects geo rules ahead of the catch-all on the ENTRY node fragments', async () => {
    const ru = await node('ru');
    const de = await node('de');
    await createCascade({
      name: 'geo-chain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: ru, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: de, position: 1 },
      ],
      egressPolicy: POLICY,
    });

    const frag = await getCascadeFragmentsForNode(ru);
    expect(frag).not.toBeNull();
    expect(frag!.routingRules).toEqual([
      { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'blocked' },
      // mixed geosite+geoip rule splits into domain + ip rules (OR, not xray AND)
      { type: 'field', domain: ['geosite:category-ru'], outboundTag: 'direct' },
      { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' },
      // QUIC-drop (upstream #15): after the geo rules, before the catch-all.
      { type: 'field', network: 'udp', port: 443, outboundTag: 'blocked' },
      { type: 'field', network: 'tcp,udp', outboundTag: 'cascade-link-out' }, // catch-all last
    ]);
    // Both `direct` and `blocked` are node-base outbounds - the service strips
    // them from the fragment so the node merge (which appends without dedup)
    // can't produce a duplicate tag that xray refuses to boot on. The geo block
    // rule still resolves against the node's own base `blocked` outbound.
    const tags = (frag!.outbounds as { tag?: string }[]).map((o) => o.tag);
    expect(tags).not.toContain('blocked');
    expect(tags).not.toContain('direct');
    // G4 - geoAssets are gated on GEO_SELF_HOST (off in tests), so a policy that
    // uses only standard categories ships no assets (node uses bundled geo).
    expect(frag).not.toHaveProperty('geoAssets');
  });

  it('leaves the EXIT node fragments free of geo rules', async () => {
    const ru = await node('ru');
    const de = await node('de');
    await createCascade({
      name: 'geo-chain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: ru, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: de, position: 1 },
      ],
      egressPolicy: POLICY,
    });

    const frag = await getCascadeFragmentsForNode(de);
    expect(frag!.routingRules).toEqual([
      { type: 'field', inboundTag: ['cascade-link-in'], outboundTag: 'direct' },
    ]);
  });

  it('a cascade with no policy has just QUIC-drop + catch-all (no geo rules, no blackhole)', async () => {
    const ru = await node('ru');
    const de = await node('de');
    await createCascade({
      name: 'plain-chain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: ru, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: de, position: 1 },
      ],
    });

    const frag = await getCascadeFragmentsForNode(ru);
    expect(frag!.routingRules).toEqual([
      { type: 'field', network: 'udp', port: 443, outboundTag: 'blocked' }, // QUIC-drop is unconditional
      { type: 'field', network: 'tcp,udp', outboundTag: 'cascade-link-out' },
    ]);
    expect((frag!.outbounds as { protocol?: string }[]).some((o) => o.protocol === 'blackhole')).toBe(
      false,
    );
  });

  it('clears the policy on update with an empty array', async () => {
    const ru = await node('ru');
    const de = await node('de');
    const dto = await createCascade({
      name: 'geo-chain',
      enabled: true,
      mode: 'chain',
      hops: [
        { nodeId: ru, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: de, position: 1 },
      ],
      egressPolicy: POLICY,
    });

    await updateCascade(dto.id, { egressPolicy: [] });
    const frag = await getCascadeFragmentsForNode(ru);
    // empty policy -> back to QUIC-drop + the catch-all (no geo rules)
    expect(frag!.routingRules).toEqual([
      { type: 'field', network: 'udp', port: 443, outboundTag: 'blocked' },
      { type: 'field', network: 'tcp,udp', outboundTag: 'cascade-link-out' },
    ]);
  });
});
