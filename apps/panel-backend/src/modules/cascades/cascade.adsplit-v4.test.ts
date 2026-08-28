import { describe, expect, it } from 'vitest';
import { buildTopologyFragmentsForNode, routeTag } from './cascade.config.js';

/**
 * An ad-split policy is offered to the subscriber as a second line per exit
 * ("DE · Без рекламы"), and the direction rule carries its band so the line
 * reaches the right exit. It has to also DO something.
 *
 * It did not. Measured on a three-node stand 2026-08-28: through the plain line
 * and through "· Без рекламы" from the same subscription, `doubleclick.net`
 * answered 301 both times, and `category-ads-all` appeared zero times in the
 * entry's config. The subscriber picks an ad-blocking profile, gets a working
 * tunnel to the right country, and no ad blocking.
 *
 * `buildCascadeConfigs` — the LEGACY hop builder — has carried these rules
 * since 2026-07-30, and its own comment records this failure being fixed once
 * already. The v4 builder, which is what actually feeds nodes, never got them.
 * One decision, two builders, the guard on the one that stopped being used.
 */

const ENTRY = 'aaaaaaaa-0000-0000-0000-000000000001';
const EXIT_A = 'bbbbbbbb-0000-0000-0000-000000000002';
const EXIT_B = 'cccccccc-0000-0000-0000-000000000003';

const twoDirections = {
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
  policies: [{ ordinal: 1, directDomains: ['geosite:private'], blockDomains: ['geosite:category-ads-all'] }],
};

const rulesOf = (nodeId: string) =>
  buildTopologyFragmentsForNode(nodeId, twoDirections)!.routingRules;

describe('an ad-split band actually carries its policy', () => {
  it('blocks the policy domains for every exit the band exists on', () => {
    const block = rulesOf(ENTRY).find(
      (r) => r.outboundTag === 'blocked' && Array.isArray(r.domain),
    );
    expect(block, 'the entry has no rule for the policy at all').toBeDefined();
    expect(block!.domain).toEqual(['geosite:category-ads-all']);
    // One band, two exits, two tags: a policy that only covered the first exit
    // would look right on a one-exit cascade and be silently half-applied here.
    expect(String(block!.vlessRoute)).toBe(`${routeTag(1, 0)},${routeTag(1, 1)}`);
  });

  it('and sends the direct list straight out, block before direct', () => {
    const rules = rulesOf(ENTRY);
    const blockAt = rules.findIndex((r) => r.outboundTag === 'blocked' && Array.isArray(r.domain));
    const directAt = rules.findIndex((r) => r.outboundTag === 'direct' && Array.isArray(r.domain));
    expect(directAt, 'no direct rule for the policy').toBeGreaterThan(-1);
    expect(rules[directAt]!.domain).toEqual(['geosite:private']);
    expect(blockAt, 'a domain in both lists must take the safer half').toBeLessThan(directAt);
  });

  it('puts them ABOVE the direction rules, or the link swallows the traffic first', () => {
    const rules = rulesOf(ENTRY);
    const policyAt = rules.findIndex((r) => r.outboundTag === 'blocked' && Array.isArray(r.domain));
    const directionAt = rules.findIndex(
      (r) => typeof r.outboundTag === 'string' && r.outboundTag.startsWith('cascade-link-out'),
    );
    expect(directionAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(directionAt);
  });

  it('says nothing about policies on a node that is not the entry', () => {
    const rules = rulesOf(EXIT_A);
    expect(rules.some((r) => Array.isArray(r.domain))).toBe(false);
  });
});
