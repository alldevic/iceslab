import { describe, expect, it } from 'vitest';
import {
  autoRouteTag,
  buildTopologyFragmentsForNode,
  MAX_DIRECTION_ORDINAL,
  routeTag,
} from './cascade.config.js';

/**
 * The Auto profile: one line in the subscription that names no country and lets
 * the entry pick the fastest way out.
 *
 * The thing worth pinning here is not that Auto works, it is that the tag and
 * the rule are one decision. A v4 entry has no catch-all: a tag nobody routes
 * falls through to `freedom` and the user egresses at the ENTRY while their
 * client shows the exit they chose. That is why an earlier, drawn-only Auto row
 * was deleted (2026-08-15) rather than kept as "mostly right".
 */
const N = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENTRY = N(1);
const EXIT_A = N(2);
const EXIT_B = N(3);

const link = (to: string, directionTag: number) => ({
  fromNodeId: ENTRY,
  toNodeId: to,
  directionTag,
  cred: { protocol: 'vless' as const, port: 24000, uuid: `u-${directionTag}` },
});

const hosts = new Map([
  [ENTRY, 'entry.example'],
  [EXIT_A, 'a.example'],
  [EXIT_B, 'b.example'],
]);

const twoDirections = {
  positions: [{ position: 0, nodeIds: [ENTRY] }],
  directions: [
    { tag: 1, nodeIds: [EXIT_A] },
    { tag: 2, nodeIds: [EXIT_B] },
  ],
  links: [link(EXIT_A, 1), link(EXIT_B, 2)],
  hosts,
  policies: [{ ordinal: 1, directDomains: [], blockDomains: [] }],
};

const autoRule = (cfg: ReturnType<typeof buildTopologyFragmentsForNode>) =>
  cfg!.routingRules.find((r) => 'balancerTag' in r && r.balancerTag === 'bal-auto');

/** Every rule that speaks for the Auto tags: the balancer one and the refusal
 *  right behind it. Both carry the same vlessRoute list, so a check about
 *  DIRECTION tags has to skip them both. */
const autoRules = (cfg: ReturnType<typeof buildTopologyFragmentsForNode>) => {
  const auto = new Set(String(autoRule(cfg)!.vlessRoute).split(','));
  return cfg!.routingRules.filter(
    (r) =>
      'vlessRoute' in r &&
      String(r.vlessRoute)
        .split(',')
        .every((t) => auto.has(t)),
  );
};

describe('the Auto tag reaches a balancer at the entry', () => {
  it('routes it, instead of letting it fall through to the entry country', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    const rule = autoRule(cfg);
    expect(rule, 'no rule matches the Auto tag').toBeDefined();
    // Comma-separated STRING. An array here fails the whole config with
    // "invalid port" and the core refuses to start (field, 2026-08-08).
    expect(typeof rule!.vlessRoute).toBe('string');
    expect(String(rule!.vlessRoute).split(',')).toContain(String(autoRouteTag(0)));
  });

  it('gives the balancer every direction, not just the pool inside one', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    const bal = cfg.balancers!.find((b) => b.tag === 'bal-auto')!;
    // A prefix selector: the point of Auto is "fastest hop out of here", which
    // has to span directions. Naming one direction's outbounds would quietly
    // reduce it to the per-direction balancer that already exists.
    expect(bal.selector).toEqual(['cascade-link-out']);
    expect(bal.strategy).toEqual({ type: 'leastPing' });
  });

  it('carries the observatory the balancer needs', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    // leastPing with nobody measuring pings is not a degraded balancer, it is a
    // config xray rejects whole: "not all dependencies are resolved", and the
    // core never starts. That took both entries down on 2026-08-15.
    expect(cfg.observatory).toBeDefined();
  });

  it('does not collide with a direction tag', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    const auto = new Set(String(autoRule(cfg)!.vlessRoute).split(','));
    const mine = new Set(autoRules(cfg));
    for (const rule of cfg.routingRules) {
      if (!('vlessRoute' in rule) || mine.has(rule)) continue;
      for (const tag of String(rule.vlessRoute).split(',')) {
        expect(auto.has(tag), `tag ${tag} means both a direction and Auto`).toBe(false);
      }
    }
    // The two spaces grow from opposite ends of the uint16 range and must not
    // touch even at their extremes: the highest tag any (policy, direction)
    // pair can produce stays below the lowest Auto tag. They used to meet at
    // exactly one value, and that value would have sent a user out through an
    // exit they did not pick, so the policy bound gave up its last ordinal.
    expect(routeTag(MAX_DIRECTION_ORDINAL, 255)).toBeLessThan(autoRouteTag(MAX_DIRECTION_ORDINAL));
  });

  /**
   * With nothing alive behind it, the Auto line must refuse - not leave from
   * the entry's own country. Measured on a two-VM chain 2026-08-28: before
   * this, Auto answered 200 with the entry's IP while every named direction
   * refused with 000, and nothing anywhere reported the difference.
   *
   * `fallbackTag` and not a rule behind the balancer: a `balancerTag` rule that
   * resolves to nothing does NOT fall through to the next rule. That was tried
   * first and measured doing nothing - the entry still logged `>> direct`.
   */
  it('refuses the Auto tag when the balancer has nothing alive, instead of egressing at the entry', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    const bal = cfg.balancers?.find((b) => b.tag === 'bal-auto');
    expect(bal, 'no Auto balancer').toBeDefined();
    expect(
      bal!.fallbackTag,
      'without a fallback the Auto line egresses at the entry when every exit is down',
    ).toBe('blocked');
    // And exactly one rule speaks for the Auto tags: a second one behind the
    // balancer would be dead weight, since xray never reaches it.
    expect(autoRules(cfg).length).toBe(1);
  });

  it('gives each policy its own Auto tag', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })!;
    const tags = String(autoRule(cfg)!.vlessRoute).split(',');
    // Otherwise "Auto" and "Auto, no ads" would be the same profile, and the
    // second would silently serve the first.
    expect(tags).toContain(String(autoRouteTag(1)));
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe('the Auto rule is absent when it would be wrong', () => {
  it('is absent while the operator has not asked for it', () => {
    const cfg = buildTopologyFragmentsForNode(ENTRY, twoDirections)!;
    expect(autoRule(cfg)).toBeUndefined();
    expect(cfg.balancers?.some((b) => b.tag === 'bal-auto') ?? false).toBe(false);
  });

  it('is absent with a single direction, where it would duplicate it', () => {
    const one = {
      ...twoDirections,
      directions: [{ tag: 1, nodeIds: [EXIT_A] }],
      links: [link(EXIT_A, 1)],
      auto: true,
    };
    const cfg = buildTopologyFragmentsForNode(ENTRY, one)!;
    expect(autoRule(cfg)).toBeUndefined();
    // And nothing else got dragged in: a lone direction still needs no
    // observatory, which is a probe every 5 minutes to every exit.
    expect(cfg.observatory).toBeUndefined();
  });

  it('is absent on an exit node, which has no choice to make', () => {
    const cfg = buildTopologyFragmentsForNode(EXIT_A, { ...twoDirections, auto: true })!;
    expect(autoRule(cfg)).toBeUndefined();
  });
});
