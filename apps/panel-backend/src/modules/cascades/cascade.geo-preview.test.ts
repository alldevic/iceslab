import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { previewNodeGeo } from './cascade.service.js';
import { buildTopologyFragmentsForNode, type TopologyInput } from './cascade.config.js';
import type { EgressPolicy } from './cascade.geo.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

/**
 * The preview's whole value is that it CANNOT be wrong: an operator debugging
 * "why doesn't my split work" learns nothing from a second implementation that
 * agrees with the builder until it stops agreeing.
 *
 * So the test is not "the preview looks plausible" but "the preview is what the
 * node gets" - the same policy through the real builder and through the preview
 * must produce the same rules, in the same order.
 */

const cred = (port: number) =>
  ({
    kind: 'vless',
    port,
    uuid: '11111111-1111-4111-8111-111111111111',
    reality: {
      privateKey: 'k',
      publicKey: 'p',
      shortId: 'ab',
      dest: 'example.com:443',
      serverName: 'example.com',
    },
  }) as never;

const ENTRY = 'aaaaaaaa-0000-4000-8000-000000000001';
const EXIT_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const EXIT_2 = 'bbbbbbbb-0000-4000-8000-000000000002';

/** An entry that fans out to two directions, the second of which is a pool of
 *  two nodes - so one direction is a plain outbound and the other a balancer. */
function topology(policy: EgressPolicy): TopologyInput {
  return {
    positions: [{ position: 0, nodeIds: [ENTRY] }],
    directions: [
      { tag: 1, nodeIds: [EXIT_1] },
      { tag: 2, nodeIds: [EXIT_2, ENTRY] },
    ],
    links: [
      { fromNodeId: ENTRY, toNodeId: EXIT_1, directionTag: 1, cred: cred(10001) },
      { fromNodeId: ENTRY, toNodeId: EXIT_2, directionTag: 2, cred: cred(10001) },
      { fromNodeId: ENTRY, toNodeId: ENTRY, directionTag: 2, cred: cred(10001) },
    ],
    hosts: new Map([
      [ENTRY, '10.0.0.1'],
      [EXIT_1, '10.0.0.2'],
      [EXIT_2, '10.0.0.3'],
    ]),
    egressPolicies: new Map([[ENTRY, policy]]),
  };
}

/** The geo rules the real builder lays down: what sits between the entry's QUIC
 *  block (always rule 0) and the first plain direction rule. */
function builtGeoRules(policy: EgressPolicy): Record<string, unknown>[] {
  const rules = buildTopologyFragmentsForNode(ENTRY, topology(policy))!.routingRules;
  const firstDirectionRule = rules.findIndex(
    (r) => 'vlessRoute' in (r as object) && !('domain' in (r as object)) && !('ip' in (r as object)),
  );
  return rules.slice(1, firstDirectionRule);
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the geo preview compiles to exactly what the node is given', () => {
  // Two directions, the second a pool: `outbounds` is the next step's pool size,
  // which is what decides balancer vs plain outbound.
  const directions = [
    { tag: 1, outbounds: 1 },
    { tag: 2, outbounds: 2 },
  ];

  it('matches the builder for target-independent rules', async () => {
    const policy: EgressPolicy = [
      { geosite: ['category-ru'], target: 'direct' },
      { geosite: ['ads'], target: 'block' },
      { geoip: ['cn'], target: 'direction', directionTag: 2 },
    ];
    const preview = await previewNodeGeo({ policy, position: 0, prevNodeIds: [], directions });
    expect(preview.rules).toEqual(builtGeoRules(policy));
  });

  it("matches the builder for 'link-out', which is one rule PER direction", async () => {
    const policy: EgressPolicy = [{ geosite: ['ads'], target: 'link-out' }];
    const preview = await previewNodeGeo({ policy, position: 0, prevNodeIds: [], directions });
    expect(preview.rules).toEqual(builtGeoRules(policy));
    // Two directions -> two rules, each carrying its own vlessRoute. A single
    // rule here would pin every client to one way out.
    expect(preview.rules).toHaveLength(2);
    expect(new Set(preview.rules.map((r) => r.vlessRoute)).size).toBe(2);
  });

  it('reports the domainStrategy an ip/geoip matcher forces on the entry', async () => {
    const withIp = await previewNodeGeo({
      policy: [{ geoip: ['ru'], target: 'direct' }],
      position: 0,
      prevNodeIds: [],
      directions,
    });
    expect(withIp.domainStrategy).toBe('IPOnDemand');

    // A domain-only policy leaves the node default alone, so the entry stays
    // byte-identical to a cascade without a split.
    const domainOnly = await previewNodeGeo({
      policy: [{ geosite: ['ads'], target: 'direct' }],
      position: 0,
      prevNodeIds: [],
      directions,
    });
    expect(domainOnly.domainStrategy).toBeUndefined();
  });

  it('names the custom matchers the node will never see', async () => {
    // Self-hosting is off in tests, so no ext: reference is satisfiable and
    // reconciliation strips it - which is exactly the state where an operator
    // stares at a rule that does nothing. The preview has to say so.
    const preview = await previewNodeGeo({
      policy: [
        { domain: ['ext:geo-custom.dat:ADS', 'example.com'], target: 'block' },
        { geosite: ['category-ru'], target: 'direct' },
      ],
      position: 0,
      prevNodeIds: [],
      directions,
    });
    expect(preview.dropped).toEqual(['ext:geo-custom.dat:ADS']);
    // The surviving literal keeps its rule, and the untouched rule is untouched.
    expect(preview.rules).toEqual([
      { type: 'field', domain: ['example.com'], outboundTag: 'blocked' },
      { type: 'field', domain: ['geosite:category-ru'], outboundTag: 'direct' },
    ]);
  });

  it('matches on the arrival credential at a transit, not on vlessRoute', async () => {
    // A transit cannot see the client's chosen direction - it only sees which
    // link the traffic arrived on. Getting this wrong would emit a rule that
    // never fires.
    const preview = await previewNodeGeo({
      policy: [{ geosite: ['ads'], target: 'link-out' }],
      position: 1,
      prevNodeIds: [ENTRY],
      directions,
    });
    expect(preview.rules).toHaveLength(2);
    for (const rule of preview.rules) {
      expect(rule).not.toHaveProperty('vlessRoute');
      expect(rule.user).toEqual([expect.stringMatching(/^lnk-d[12]-aaaaaaaa$/)]);
    }
  });

  it('drops a rule forcing a direction that has no way out from here', async () => {
    // A direction with an empty pool cannot be steered into. Emitting the rule
    // anyway would name an outbound that does not exist, and xray refuses the
    // whole config over it.
    const preview = await previewNodeGeo({
      policy: [{ geosite: ['ads'], target: 'direction', directionTag: 9 }],
      position: 0,
      prevNodeIds: [],
      directions,
    });
    expect(preview.rules).toEqual([]);
  });
});
