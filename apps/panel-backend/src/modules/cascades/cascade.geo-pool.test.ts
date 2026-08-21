import { describe, expect, it } from 'vitest';
import { buildTopologyFragmentsForNode, type TopologyInput } from './cascade.config.js';
import type { EgressPolicy } from './cascade.geo.js';

/**
 * The geo split is a property of a NODE, not of the cascade or of a position.
 *
 * v4 lets a position hold a pool, and the bug this pins is the one the pool
 * model exists to prevent: hanging the policy on the cascade would apply one
 * operator's split to every box in the pool, and hanging it on the position
 * would do the same. Only the node that was given a policy may carry its rules.
 */

const cred = (port: number) =>
  ({ kind: 'vless', port, uuid: '11111111-1111-4111-8111-111111111111', reality: {
    privateKey: 'k', publicKey: 'p', shortId: 'ab', dest: 'example.com:443', serverName: 'example.com',
  } }) as never;

// Two entry nodes (a pool) -> one direction node.
const ENTRY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ENTRY_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const EXIT = 'bbbbbbbb-0000-4000-8000-000000000001';

const POLICY: EgressPolicy = [{ geosite: ['category-ru'], target: 'direct' }];

function input(policies?: Map<string, EgressPolicy>): TopologyInput {
  return {
    positions: [{ position: 1, nodeIds: [ENTRY_A, ENTRY_B] }],
    directions: [{ tag: 1, nodeIds: [EXIT] }],
    links: [
      { fromNodeId: ENTRY_A, toNodeId: EXIT, directionTag: 1, cred: cred(10001) },
      { fromNodeId: ENTRY_B, toNodeId: EXIT, directionTag: 1, cred: cred(10001) },
    ],
    hosts: new Map([[ENTRY_A, '10.0.0.1'], [ENTRY_B, '10.0.0.2'], [EXIT, '10.0.0.3']]),
    ...(policies ? { egressPolicies: policies } : {}),
  };
}

const geoRules = (nodeId: string, inp: TopologyInput) =>
  (buildTopologyFragmentsForNode(nodeId, inp)?.routingRules ?? []).filter((r) =>
    Array.isArray((r as { domain?: unknown }).domain),
  );

describe('per-node geo split across an entry pool', () => {
  it('only the node holding the policy renders geo rules', () => {
    const inp = input(new Map([[ENTRY_A, POLICY]]));
    expect(geoRules(ENTRY_A, inp)).toHaveLength(1);
    expect(geoRules(ENTRY_B, inp)).toHaveLength(0);
  });

  it('the rule carries the qualified matcher and egresses direct', () => {
    const [rule] = geoRules(ENTRY_A, input(new Map([[ENTRY_A, POLICY]])));
    expect(rule).toMatchObject({ type: 'field', domain: ['geosite:category-ru'], outboundTag: 'direct' });
  });

  it('a geo rule sits AHEAD of the direction rule it would otherwise lose to', () => {
    const rules = buildTopologyFragmentsForNode(ENTRY_A, input(new Map([[ENTRY_A, POLICY]])))!.routingRules;
    const geo = rules.findIndex((r) => Array.isArray((r as { domain?: unknown }).domain));
    const direction = rules.findIndex((r) => 'vlessRoute' in (r as object));
    expect(geo).toBeGreaterThanOrEqual(0);
    expect(direction).toBeGreaterThan(geo);
  });

  it('no policy anywhere renders byte-identically to a plain cascade', () => {
    expect(buildTopologyFragmentsForNode(ENTRY_A, input())).toEqual(
      buildTopologyFragmentsForNode(ENTRY_A, input(new Map())),
    );
  });

  it("a 'link-out' rule is emitted per direction, carrying that direction's own condition", () => {
    // link-out means "the way out the client already chose", which at a v4 entry
    // is a different target per direction - so it cannot be one prepended rule.
    const inp = input(new Map([[ENTRY_A, [{ geosite: ['ads'], target: 'link-out' }] as EgressPolicy]]));
    const rules = buildTopologyFragmentsForNode(ENTRY_A, inp)!.routingRules;
    const withDomain = rules.filter((r) => Array.isArray((r as { domain?: unknown }).domain));
    expect(withDomain).toHaveLength(1); // one direction here
    expect(withDomain[0]).toHaveProperty('vlessRoute');
  });

  it('a rule naming a direction that no longer exists is dropped, not shipped pointing nowhere', () => {
    const stale: EgressPolicy = [{ geosite: ['ads'], target: 'direction', directionTag: 99 }];
    expect(geoRules(ENTRY_A, input(new Map([[ENTRY_A, stale]])))).toHaveLength(0);
  });
});
