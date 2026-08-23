import { z } from 'zod';
import type { RoutingFragmentsCfg } from '@iceslab/shared';
import { ZAPRET2_OUTBOUND_TAG } from './egress.presets.js';

/**
 * The fork's egress language: an operator writes match -> target rules, and a
 * compiler turns them into the xray routing rules a node renders.
 *
 * ONE language, two scopes, because the same sentence is worth saying in two
 * places:
 *
 *   - per NODE (B1, Node.hardening.egressPolicy): which flows leave this
 *     machine by which way out. Compiled here against the node's capabilities.
 *   - per CASCADE MEMBER (E, CascadePositionNode.egressPolicy): the same, for
 *     one hop of one chain, where the ways out are the chain's directions.
 *     Compiled in cascade.config.ts, which supplies those as targets.
 *
 * The scopes stay separate because a node can be a hop in several cascades with
 * a different split in each - the storage is keyed (position, node) for exactly
 * that. What must NOT differ is the language: two schemas of the same idea let
 * a policy authored in one place fail validation in the other, and let one
 * compiler carry a fix the other never gets. That happened once already; see
 * compileRules on why domain and ip cannot share a rule.
 *
 * A rule's target is a capability, not an outbound tag. Resolution is per scope
 * and per node, and a rule naming something this node cannot serve is DROPPED:
 * an xray config with an outboundTag no outbound answers is one xray refuses to
 * start on, so a single stale row would otherwise take the node dark.
 */

/** A matcher token: a geosite/geoip category name, or a literal domain/ip. */
const Matcher = z.string().min(1).max(256);

/**
 * Where a matched flow leaves.
 *
 *   - `direct`: the node's own IP, bypassing whatever its default egress is.
 *   - `block`: the blackhole.
 *   - `warp`: the Cloudflare WARP outbound, on a node that has WARP enabled.
 *   - `zapret2`: the node's local DPI-desync proxy (B2a), which is how a node
 *     inside a censored network reaches a blocked destination.
 *   - `link-out`: the way out the client already chose, i.e. onward through the
 *     cascade. Only a cascade hop can serve it.
 *   - `direction`: a specific way out of the cascade, named by `directionTag`,
 *     overriding what the client asked for.
 *
 * The vocabulary is shared even though no single scope serves all of it: a node
 * policy naming `direction` and a cascade policy naming `zapret2` both compile
 * to nothing, which is the same safe outcome as naming a channel the node has
 * not got. That also means a combination we have not built yet (routing a
 * cascade hop's blocked traffic into its desync proxy) is a resolution entry
 * away rather than a schema change.
 */
export const EGRESS_TARGETS = [
  'direct',
  'block',
  'warp',
  'zapret2',
  'link-out',
  'direction',
] as const;
export const EgressTargetSchema = z.enum(EGRESS_TARGETS);

export const EgressRuleSchema = z
  .object({
    /** geosite category names (xray-bundled or `ext:file.dat:cat`); prefixed
     *  `geosite:` unless already qualified (contains a colon). */
    geosite: z.array(Matcher).max(512).optional(),
    /** geoip category names ('ru', 'private'); prefixed `geoip:` unless already
     *  qualified. */
    geoip: z.array(Matcher).max(512).optional(),
    /** Literal domain matchers, passed through verbatim ('example.com',
     *  'domain:foo', 'ext:f.dat:c'). */
    domain: z.array(Matcher).max(4096).optional(),
    /** Literal IP/CIDR matchers, passed through verbatim ('10.0.0.0/8'). */
    ip: z.array(Matcher).max(4096).optional(),
    /** xray port matcher ('443', '1000-2000', '80,443'). */
    port: z
      .string()
      .max(64)
      .regex(/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/)
      .optional(),
    /** Restrict the rule to a transport. */
    network: z.enum(['tcp', 'udp', 'tcp,udp']).optional(),
    target: EgressTargetSchema,
    /** Required for target 'direction': the frozen tag of the way out a match is
     *  forced through. Tags identify a DIRECTION and survive its node pool
     *  changing, which is why the policy stores the tag and not a node id. */
    directionTag: z.number().int().positive().optional(),
  })
  // Strict: a mistyped key must fail the save instead of persisting as a no-op
  // the operator cannot see. Same reason HardeningSchema is strict.
  .strict()
  .refine((r) => r.target !== 'direction' || r.directionTag !== undefined, {
    message: "target 'direction' needs a directionTag",
  })
  .refine(
    (r) =>
      Boolean(r.geosite?.length || r.geoip?.length || r.domain?.length || r.ip?.length || r.port),
    { message: 'each egress rule needs at least one matcher (geosite/geoip/domain/ip/port)' },
  );

export const EgressPolicySchema = z.array(EgressRuleSchema).max(128);

/**
 * A matcher naming a custom category out of a panel-built .dat, e.g.
 * `ext:geo-custom.dat:MYCAT`. Only usable where the file itself reaches the
 * node.
 */
export function isExtMatcher(m: string): boolean {
  return m.startsWith('ext:');
}

export function ruleUsesExtMatcher(r: EgressRule): boolean {
  return [...(r.geosite ?? []), ...(r.geoip ?? []), ...(r.domain ?? []), ...(r.ip ?? [])].some(
    isExtMatcher,
  );
}

/**
 * The NODE scope's policy: the shared language minus custom categories.
 *
 * xray fails config load on an `ext:` file it has not got and then crash-loops,
 * taking every user on that node with it, so such a matcher may only be shipped
 * where the panel also delivers the file. Today that delivery rides the cascade
 * fragments (geoAssets, see the geo subsystem), which reach a node because it is
 * a hop in a chain - a node's own policy has no such channel. Until it does, the
 * node scope refuses these at the point they are typed, rather than accepting
 * them and taking the node down on the next push.
 */
export const NodeEgressPolicySchema = EgressPolicySchema.superRefine((policy, ctx) => {
  policy.forEach((r, index) => {
    if (ruleUsesExtMatcher(r)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'custom (ext:) categories are only available on a cascade hop, where the panel also delivers the file; use a standard geosite/geoip category here',
        path: [index],
      });
    }
  });
});

export type EgressTarget = z.infer<typeof EgressTargetSchema>;
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

/**
 * What to merge into a rule for each target: `{ outboundTag }` for a fixed
 * outbound, or `{ balancerTag }` when a pool serves that way out.
 *
 * Keys are target names, plus `direction:<tag>` per direction the caller can
 * steer into. A target the caller did not supply resolves to nothing and its
 * rules are dropped.
 */
export type TargetRouting = Record<string, Record<string, unknown>>;

/** The targets key for a rule that forces a specific way out. */
export function directionTargetKey(tag: number): string {
  return `direction:${tag}`;
}

/**
 * Defensively coerce a persisted policy (a Prisma JsonValue) into an
 * EgressPolicy, or undefined when it is absent or has drifted out of shape. A
 * half-valid policy compiles to nothing rather than to a partial split the
 * operator cannot see: the node then routes as it did before, which is the safe
 * direction to fail in.
 */
export function coerceEgressPolicy(raw: unknown): EgressPolicy | undefined {
  if (raw == null) return undefined;
  const parsed = EgressPolicySchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

/** One rule that could not be rendered, for the caller to log. */
export interface DroppedRule {
  /** Index in the authored policy, so the operator can find the row. */
  index: number;
  target: EgressTarget;
  reason: string;
}

export interface CompiledRules {
  /** Field rules, in the operator's order. */
  rules: Record<string, unknown>[];
  /** True when a rule targets 'block' (the caller must have a blackhole). */
  needsBlock: boolean;
  dropped: DroppedRule[];
}

// A colon means the matcher is already qualified (geosite:/geoip:/ext:/domain:/
// full:/regexp:/keyword:) or is an IPv6 literal - leave it untouched.
const QUALIFIED = /:/;

function qualify(prefix: string, values: string[] | undefined): string[] {
  return (values ?? []).map((v) => (QUALIFIED.test(v) ? v : `${prefix}:${v}`));
}

/**
 * True when the policy has an ip/geoip matcher, i.e. a rule that can only be
 * evaluated once xray has resolved the destination to an IP.
 *
 * Such a policy needs routing.domainStrategy raised to IPOnDemand. With
 * sniffing on, a flow is routed by its sniffed DOMAIN, and under the default
 * IPIfNonMatch xray resolves that domain for a second pass only if NO rule
 * matched the first - a node with a cascade catch-all or a WARP rule always has
 * a later rule that matches, so the second pass never comes and the ip rule is
 * dead. A geosite/domain-only policy keeps the default, so it stays
 * byte-identical to a node without one.
 *
 * CAVEAT, still unvalidated on a live node: IPOnDemand resolves through the
 * NODE's DNS, which can answer differently than the client's resolver for CDN
 * and geo-DNS names, so a geoip match is approximate.
 */
export function policyNeedsIpResolution(policy: EgressPolicy | undefined): boolean {
  return (policy ?? []).some((r) => Boolean(r.geoip?.length || r.ip?.length));
}

/** The domainStrategy a policy needs, or undefined to keep the node default. */
export function egressDomainStrategy(policy: EgressPolicy | undefined): 'IPOnDemand' | undefined {
  return policyNeedsIpResolution(policy) ? 'IPOnDemand' : undefined;
}

/**
 * Compile a policy into xray field rules against a scope's targets.
 *
 * Rule order is preserved: xray takes the first matching rule, so the
 * operator's order is the precedence they see in the UI.
 *
 * domain and ip go into SEPARATE rules. xray ANDs the conditions inside one
 * rule, so a rule carrying both would demand that the destination match a
 * domain AND an IP condition - the classic geosite+geoip-in-one-rule trap. The
 * policy means "any of these -> target", and a rule that reads as "or" in the
 * UI must not compile to "and".
 */
export function compileRules(
  policy: EgressPolicy | undefined,
  targets: TargetRouting,
  /** Whether this scope can deliver custom (ext:) categories to the node. Only
   *  the cascade scope can today; see NodeEgressPolicySchema. */
  { allowExt = true }: { allowExt?: boolean } = {},
): CompiledRules {
  const rules: Record<string, unknown>[] = [];
  const dropped: DroppedRule[] = [];
  let needsBlock = false;

  (policy ?? []).forEach((r, index) => {
    const domain = [...qualify('geosite', r.geosite), ...(r.domain ?? [])];
    const ip = [...qualify('geoip', r.geoip), ...(r.ip ?? [])];
    if (!allowExt && ruleUsesExtMatcher(r)) {
      // Defence in depth behind NodeEgressPolicySchema: a rule stored before
      // that guard existed must not reach a node that cannot resolve it.
      dropped.push({ index, target: r.target, reason: 'custom (ext:) category cannot reach this node' });
      return;
    }
    // A rule with no matcher at all behaves as a catch-all and would shadow
    // every rule under it, including the cascade's own. The schema rejects one,
    // so this only catches drifted data, but the cost of being wrong is the
    // whole node's traffic.
    if (domain.length === 0 && ip.length === 0 && r.port === undefined) {
      dropped.push({ index, target: r.target, reason: 'rule has no matcher' });
      return;
    }
    const key = r.target === 'direction' ? directionTargetKey(r.directionTag!) : r.target;
    const fragment = targets[key];
    if (fragment === undefined) {
      dropped.push({
        index,
        target: r.target,
        reason:
          r.target === 'direction'
            ? `no direction ${r.directionTag} here`
            : `node has no ${r.target} egress`,
      });
      return;
    }
    const base: Record<string, unknown> = { type: 'field' };
    if (r.port !== undefined) base.port = r.port;
    if (r.network !== undefined) base.network = r.network;
    Object.assign(base, fragment);
    if (r.target === 'block') needsBlock = true;
    if (domain.length > 0) rules.push({ ...base, domain });
    if (ip.length > 0) rules.push({ ...base, ip });
    if (domain.length === 0 && ip.length === 0) rules.push(base); // port/network only
  });

  return { rules, needsBlock, dropped };
}

// ───── node scope ─────

/**
 * What ways out a node has. Built from the node row by the caller, so this
 * module needs no database access and stays a pure compiler.
 *
 * `direct` and `block` are not listed: every xray config carries the `direct`
 * and `blocked` outbounds unconditionally.
 */
export interface NodeEgressCapabilities {
  /** Cloudflare WARP is registered and enabled on this node. */
  warp: boolean;
  /**
   * The zapret2 desync channel runs here, with its SOCKS frontend on this port.
   * null when the node does not run it (never provisioned, or switched off), in
   * which case a rule targeting zapret2 is dropped rather than pointed at a
   * port nothing listens on.
   */
  zapret2SocksPort: number | null;
}

export interface CompiledEgressPolicy {
  /** What to attach to the node's xray inbound, or null when nothing survived. */
  fragments: RoutingFragmentsCfg | null;
  dropped: DroppedRule[];
}

/** The ways out a node itself can serve. The cascade scope builds its own map
 *  from the chain's directions (see cascade.config.ts). Exported so the split
 *  preview can compile the node's own policy the same way the push does,
 *  instead of a second implementation that agrees until it stops agreeing. */
export function nodeEgressTargets(caps: NodeEgressCapabilities): TargetRouting {
  const targets: TargetRouting = {
    direct: { outboundTag: 'direct' },
    block: { outboundTag: 'blocked' },
  };
  if (caps.warp) targets.warp = { outboundTag: 'warp' };
  if (caps.zapret2SocksPort !== null) targets.zapret2 = { outboundTag: ZAPRET2_OUTBOUND_TAG };
  return targets;
}

/**
 * The xray outbound that feeds the local zapret2 proxy. Emitted only when a
 * surviving rule actually targets it: an unused outbound would be dead weight
 * in every node's config, and the tag must not exist without a listener behind
 * it in case a later hand-edit references it.
 */
function zapret2SocksOutbound(port: number): Record<string, unknown> {
  return {
    tag: ZAPRET2_OUTBOUND_TAG,
    protocol: 'socks',
    settings: { servers: [{ address: '127.0.0.1', port }] },
  };
}

/** Compile a NODE's policy against the ways out that node actually has. */
export function compileEgressPolicy(
  policy: EgressPolicy | undefined,
  caps: NodeEgressCapabilities,
): CompiledEgressPolicy {
  if (!policy || policy.length === 0) return { fragments: null, dropped: [] };

  const { rules, dropped } = compileRules(policy, nodeEgressTargets(caps), { allowExt: false });
  if (rules.length === 0) return { fragments: null, dropped };

  const outbounds: unknown[] = [];
  if (rules.some((r) => r.outboundTag === ZAPRET2_OUTBOUND_TAG)) {
    // Non-null: a rule only carries this tag when the capability was present.
    outbounds.push(zapret2SocksOutbound(caps.zapret2SocksPort as number));
  }
  // Only the rules that survived can need IP resolution.
  const needsIp = rules.some((r) => Array.isArray(r.ip) && (r.ip as unknown[]).length > 0);

  return {
    fragments: {
      // `type: 'field'` is dropped here on purpose: the cascade scope merges its
      // rules into the config as raw xray objects and needs it, while the node
      // scope sends a structured shape the agent renders itself (it adds the
      // type). Leaving it on would put a key on the wire that the documented
      // RoutingFragmentsCfg does not have and the node ignores.
      rules: rules.map(({ type: _type, ...rule }) => rule) as RoutingFragmentsCfg['rules'],
      ...(outbounds.length > 0 ? { outbounds } : {}),
      ...(needsIp ? { domainStrategy: 'IPOnDemand' as const } : {}),
    },
    dropped,
  };
}
