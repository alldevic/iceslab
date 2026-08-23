/**
 * E - the CASCADE scope of the fork's egress language. The language itself (the
 * rule schema, the target vocabulary, and the compiler that turns rules into
 * xray field rules) lives in modules/egress/egress.policy.ts and is shared with
 * the per-node scope; this module is what the cascade adds on top: the ways out
 * of a chain, and the entry-hop wrapper cascade.config.ts calls.
 *
 * Kept as a separate scope, not merged into the node policy, because the same
 * node can be a hop in several cascades with a different split in each: the
 * storage is keyed (position, node) for exactly that reason.
 *
 * The node already honours geosite:/geoip: rules (sniffing + domainStrategy are
 * set in xray/config.go) and merges CascadeFragments.routingRules verbatim, so
 * no node-agent change is needed for standard (xray-bundled) categories. Custom
 * categories (a downloaded ext:<file>.dat) reuse the same rule shape with an
 * `ext:` matcher.
 */
export {
  EgressTargetSchema,
  EgressRuleSchema,
  EgressPolicySchema,
  coerceEgressPolicy,
  directionTargetKey,
  policyNeedsIpResolution,
  type EgressTarget,
  type EgressRule,
  type EgressPolicy,
  type TargetRouting,
} from '../egress/egress.policy.js';

import {
  compileRules,
  egressDomainStrategy,
  type EgressPolicy,
  type TargetRouting,
} from '../egress/egress.policy.js';

/** The xray routing.domainStrategy an entry must use for its egress policy, or
 *  undefined to keep the node default. See egressDomainStrategy. */
export const entryDomainStrategy = egressDomainStrategy;

export interface CompiledEntryGeo {
  /** Field rules to PREPEND before the entry catch-all. */
  rules: Record<string, unknown>[];
  /** True when any rule targets 'block' (the caller must add a blackhole outbound). */
  needsBlock: boolean;
}

/**
 * Compile an egress policy into entry-hop field rules. `targets` maps each
 * target to the routing fragment that steers a match there, so the same
 * compiler serves a chain entry (where 'link-out' is `{outboundTag}`) and a
 * balancer entry (where it is `{balancerTag}`).
 *
 * A thin wrapper over the shared compiler: the cascade scope ignores the
 * dropped-rule report (a direction deleted since the policy was authored is an
 * ordinary state here, not something to warn about on every push).
 */
export function compileEntryGeoRules(
  policy: EgressPolicy | undefined,
  targets: TargetRouting,
): CompiledEntryGeo {
  const { rules, needsBlock } = compileRules(policy, targets);
  return { rules, needsBlock };
}
