import { describe, expect, it } from 'vitest';
import { buildTopologyFragmentsForNode, routeTag } from './cascade.config.js';

/**
 * A v4 entry has no catch-all: traffic is routed by the tag in the client's
 * UUID, and a tag no rule matches falls through to the default outbound, which
 * is `freedom`. The client then egresses AT THE ENTRY - the one outcome a
 * cascade exists to prevent - and says nothing about it: it connects,
 * authenticates as the right user, fetches successfully, and reports whatever
 * country its subscription line claimed.
 *
 * So the entry must end in a refusal. These tests pin that it is there, that it
 * is LAST (a terminal rule above a direction rule would blackhole everybody),
 * and that it changes nothing for a tagged client.
 *
 * The stale client this catches is the reason the rule is worth its cost: a
 * subscription downloaded before the exits existed cannot be recalled, and
 * every format now writes the tag (cascade-exit-expansion.mirror.test.ts), so
 * what remains is the copy already on someone's phone.
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
    [EXIT_A, 'a.example'],
    [EXIT_B, 'b.example'],
  ]),
};

const rulesOf = (nodeId: string, input = topology) =>
  buildTopologyFragmentsForNode(nodeId, input)!.routingRules;

/** The refusal: catches every network, names no tag, blackholes. */
const isTerminal = (r: Record<string, unknown>): boolean =>
  r.outboundTag === 'blocked' && r.vlessRoute === undefined && r.domain === undefined &&
  r.ip === undefined && r.network === 'tcp,udp';

describe('a v4 entry refuses traffic it has no tag for', () => {
  it('emits the terminal refusal', () => {
    expect(
      rulesOf(ENTRY).some(isTerminal),
      'no terminal rule: an untagged UUID falls to freedom and egresses at the entry',
    ).toBe(true);
  });

  it('puts it LAST - above a direction rule it would blackhole everybody', () => {
    const rules = rulesOf(ENTRY);
    expect(rules.findIndex(isTerminal)).toBe(rules.length - 1);
  });

  it('leaves every direction reachable by its own tag', () => {
    const rules = rulesOf(ENTRY);
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
    expect(rulesOf(EXIT_A).some(isTerminal)).toBe(false);
  });

  it('still refuses when the entry carries a geo policy, and below it', () => {
    // The node's own policy has no tag condition, so a stale client keeps the
    // domains that policy sends `direct` and loses the rest. Loud, not total -
    // and the split rules must stay ABOVE the refusal or they do nothing.
    const withPolicy = {
      ...topology,
      egressPolicies: new Map([[ENTRY, [{ geosite: ['category-ru'], target: 'direct' as const }]]]),
    };
    const rules = rulesOf(ENTRY, withPolicy as never);
    const directAt = rules.findIndex((r) => r.outboundTag === 'direct' && r.vlessRoute === undefined);
    const terminalAt = rules.findIndex(isTerminal);
    expect(directAt, 'the node split rule is gone').toBeGreaterThanOrEqual(0);
    expect(directAt).toBeLessThan(terminalAt);
  });
});
