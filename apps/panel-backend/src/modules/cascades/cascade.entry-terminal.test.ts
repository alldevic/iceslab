import { describe, expect, it } from 'vitest';
import { buildTopologyFragmentsForNode, routeTag } from './cascade.config.js';

/**
 * A v4 entry routes by the tag in the client's UUID. Traffic that no route
 * takes (a UUID without a tag, a trojan/vmess/socks profile of the same node, a
 * WARP inbound) used to fall through to the default outbound, `freedom`, and
 * leave from the ENTRY country while every party reported success. By decision
 * ("deny all") the entry now ends in a refusal.
 *
 * These tests pin that it is there, that it is LAST (a terminal rule above a
 * direction rule would blackhole everybody), that it is in both xray drawings
 * (`legacy` and `handover`), and that exits and transits do not get one. The
 * balancers carry `fallbackTag` for the same reason: a `balancerTag` rule that
 * resolves to nothing does not fall through to the next rule.
 */

const ENTRY = 'aaaaaaaa-0000-0000-0000-000000000001';
const EXIT_A = 'bbbbbbbb-0000-0000-0000-000000000002';
const EXIT_B = 'cccccccc-0000-0000-0000-000000000003';

const topology = {
  positions: [{ position: 0, nodeIds: [ENTRY] }],
  directions: [
    { tag: 1, nodeIds: [EXIT_A] },
    { tag: 2, nodeIds: [EXIT_B] },
  ],
  links: [
    {
      fromNodeId: ENTRY,
      toNodeId: EXIT_A,
      directionTag: 1,
      cred: { protocol: 'vless' as const, port: 24000, uuid: 'u-1' },
    },
    {
      fromNodeId: ENTRY,
      toNodeId: EXIT_B,
      directionTag: 2,
      cred: { protocol: 'vless' as const, port: 24000, uuid: 'u-2' },
    },
  ],
  hosts: new Map([
    [ENTRY, 'entry.example'],
    [EXIT_A, 'a.example'],
    [EXIT_B, 'b.example'],
  ]),
};

const rulesOf = (nodeId: string, input: Record<string, unknown> = topology) =>
  buildTopologyFragmentsForNode(nodeId, input as typeof topology)!.routingRules;

const DRAWINGS = {
  legacy: topology,
  handover: { ...topology, chainSocksPassword: 'p'.repeat(24) },
};

/** The refusal: catches every network, names no tag, blackholes. */
const isTerminal = (r: Record<string, unknown>): boolean =>
  r.outboundTag === 'blocked' && r.vlessRoute === undefined && r.domain === undefined &&
  r.ip === undefined && r.network === 'tcp,udp';

describe.each(Object.entries(DRAWINGS))('a v4 entry refuses traffic it has no tag for (%s)', (_name, input) => {
  const rulesOf2 = (id: string) => rulesOf(id, input);
  it('emits the terminal refusal', () => {
    expect(
      rulesOf2(ENTRY).some(isTerminal),
      'no terminal rule: an untagged UUID falls to freedom and egresses at the entry',
    ).toBe(true);
  });

  it('puts it LAST - above a direction rule it would blackhole everybody', () => {
    const rules = rulesOf2(ENTRY);
    expect(rules.findIndex(isTerminal)).toBe(rules.length - 1);
  });

  it('leaves every direction reachable by its own tag', () => {
    const rules = rulesOf2(ENTRY);
    for (const tag of [routeTag(0, 0), routeTag(0, 1)]) {
      const rule = rules.find((r) => String(r.vlessRoute ?? '').split(',').includes(String(tag)));
      expect(rule, `direction tag ${tag} has no rule of its own`).toBeDefined();
      expect(rule!.outboundTag ?? rule!.balancerTag).toBeDefined();
      // And it sits above the refusal, or the refusal would win.
      expect(rules.indexOf(rule!)).toBeLessThan(rules.findIndex(isTerminal));
    }
  });

  it('does not put one on an EXIT - there the link credential identifies the traffic', () => {
    // An exit that blackholed unmatched traffic would refuse its own egress:
    // its rules select by arriving link user, and everything else is the
    // node's ordinary business.
    expect(rulesOf2(EXIT_A).some(isTerminal)).toBe(false);
  });

  it('stands after the user-gate trap', () => {
    const gated = {
      ...input,
      entryUserGate: new Map([['u1', new Set([routeTag(0, 0)])]]),
    };
    const rules = rulesOf(ENTRY, gated);
    const trap = rules.findIndex(
      (r) => r.outboundTag === 'blocked' && typeof r.vlessRoute === 'string' && !isTerminal(r),
    );
    expect(trap, 'the gate trap is gone').toBeGreaterThanOrEqual(0);
    expect(rules.findIndex(isTerminal)).toBe(rules.length - 1);
    expect(rules.findIndex(isTerminal)).toBeGreaterThan(trap);
  });
});

describe('a direction pool with nothing alive refuses instead of leaving from the entry', () => {
  const pool = {
    ...topology,
    directions: [{ tag: 1, nodeIds: [EXIT_A, EXIT_B] }],
    links: [topology.links[0]!, { ...topology.links[1]!, directionTag: 1 }],
  };

  it('carries fallbackTag on bal-d<tag>', () => {
    const bal = buildTopologyFragmentsForNode(ENTRY, pool)!.balancers?.find((b) => b.tag === 'bal-d1');
    expect(bal, 'no pool balancer').toBeDefined();
    expect(bal!.fallbackTag).toBe('blocked');
  });
});
