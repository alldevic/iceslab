import { z } from 'zod';
import type { RoutingFragmentsCfg } from '@iceslab/shared';
import { ZAPRET2_OUTBOUND_TAG } from './egress.presets.js';

/**
 * B1 - a node's server-side egress policy: which flows leave this node by which
 * way out. The operator authors match -> target rules; this module compiles
 * them into the xray routing fragments the node renders (RoutingFragmentsCfg in
 * packages/shared, RoutingFragments in apps/node/.../xray/config.go).
 *
 * Why the policy belongs to the NODE and not to the profile: a target is a
 * capability of one machine. A desync proxy runs on the nodes where it was
 * provisioned, WARP is registered per node, a cascade link-out exists only on a
 * hop. A profile is deployed to many nodes at once, so a rule authored there
 * would reach nodes that do not have the channel it names, and an xray config
 * with an unknown outboundTag is one xray refuses to start on: a single stale
 * policy row would take those nodes dark. Compiling per node also means the
 * panel, which knows the fleet, resolves the target - the node stays a
 * renderer.
 *
 * A rule naming a capability this node lacks is DROPPED, not rendered pointing
 * nowhere. The caller logs what it dropped (see compileEgressPolicy).
 */

/** A matcher token: a geosite/geoip category name, or a literal domain/ip. */
const Matcher = z.string().min(1).max(256);

/**
 * Where a matched flow leaves the node.
 *
 *   - `direct`: this node's own IP, bypassing whatever the node's default
 *     egress is (the point of a "RU domains stay local" split).
 *   - `block`: the blackhole.
 *   - `warp`: the Cloudflare WARP outbound, on a node that has WARP enabled.
 *     Mostly redundant there, since the node already sends everything the
 *     policy did NOT match to WARP, but it lets a rule say so explicitly and
 *     survive the node's default egress changing.
 *   - `zapret2`: the node's local DPI-desync proxy (B2a). The flow goes into
 *     ss-zapret2's SOCKS frontend and leaves desynchronised from there, which
 *     is how a node inside a censored network reaches a blocked destination.
 *
 * This is where the three egress channels compose. They are NOT three
 * independent toggles racing each other: WARP is the node's DEFAULT egress
 * (upstream renders a catch-all rule for it), zapret2 is a CHANNEL that only
 * the flows named here take, and `direct` is the way to opt a flow out of
 * whichever of the two the node runs. The sing-box engine is not a channel at
 * all: it is an alternative renderer that emits no routing section, so a node
 * serving this profile through it is refused the policy outright (see the
 * guard in apps/node/internal/core/singbox/adapter.go).
 *
 * Extended, not redefined, as more channels land: the geo subsystem's cascade
 * targets ('link-out', a frozen direction tag) join here when the branches
 * meet. Adding a target means adding one entry to the capability resolution
 * below.
 */
export const EGRESS_TARGETS = ['direct', 'block', 'warp', 'zapret2'] as const;
export const EgressTargetSchema = z.enum(EGRESS_TARGETS);

export const EgressRuleSchema = z
  .object({
    /** geosite category names ('youtube', or already-qualified 'ext:f.dat:c'). */
    geosite: z.array(Matcher).max(512).optional(),
    /** geoip category names ('ru', 'private'). */
    geoip: z.array(Matcher).max(512).optional(),
    /** Literal domain matchers, passed through verbatim ('example.com',
     *  'domain:foo', 'full:bar.example'). */
    domain: z.array(Matcher).max(1024).optional(),
    /** Literal IP/CIDR matchers, passed through verbatim ('10.0.0.0/8'). */
    ip: z.array(Matcher).max(1024).optional(),
    /** Single port, range '1000-2000', or comma list '80,443'. */
    port: z
      .string()
      .max(64)
      .regex(/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/)
      .optional(),
    network: z.enum(['tcp', 'udp', 'tcp,udp']).optional(),
    target: EgressTargetSchema,
  })
  .strict()
  .refine(
    (r) => Boolean(r.geosite?.length || r.geoip?.length || r.domain?.length || r.ip?.length || r.port),
    { message: 'each egress rule needs at least one matcher (geosite/geoip/domain/ip/port)' },
  );

export const EgressPolicySchema = z.array(EgressRuleSchema).max(64);

export type EgressTarget = z.infer<typeof EgressTargetSchema>;
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

/**
 * Defensively coerce a persisted policy (a Prisma JsonValue out of
 * Node.hardening) into an EgressPolicy, or undefined when it is absent or has
 * drifted out of shape. A half-valid policy compiles to nothing rather than to
 * a partial split the operator cannot see: the node then routes as it did
 * before, which is the safe direction to fail in.
 */
export function coerceEgressPolicy(raw: unknown): EgressPolicy | undefined {
  if (raw == null) return undefined;
  const parsed = EgressPolicySchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

/**
 * What ways out a node actually has. Built from the node row by the caller, so
 * this module needs no database access and stays a pure compiler.
 *
 * `direct` and `block` are not listed: every xray config carries the `direct`
 * and `blocked` outbounds unconditionally.
 */
export interface NodeEgressCapabilities {
  /** Cloudflare WARP is registered and enabled on this node. */
  warp: boolean;
  /**
   * The zapret2 desync channel runs here, with its SOCKS frontend on this port.
   * null when the node does not run it (never provisioned, or switched off),
   * in which case a rule targeting zapret2 is dropped rather than pointed at a
   * port nothing listens on.
   */
  zapret2SocksPort: number | null;
}

/** One rule that could not be rendered, for the caller to log. */
export interface DroppedRule {
  /** Index in the authored policy, so the operator can find the row. */
  index: number;
  target: EgressTarget;
  reason: string;
}

export interface CompiledEgressPolicy {
  /** What to attach to the node's xray inbound, or null when nothing survived. */
  fragments: RoutingFragmentsCfg | null;
  dropped: DroppedRule[];
}

/** A colon means the matcher is already qualified (geosite:/geoip:/ext:/full:/
 *  domain:/regexp:/keyword:) or is an IPv6 literal, so leave it untouched. */
const QUALIFIED = /:/;

function qualify(prefix: string, values: string[] | undefined): string[] {
  return (values ?? []).map((v) => (QUALIFIED.test(v) ? v : `${prefix}:${v}`));
}

/**
 * Resolve a target to the outbound tag that carries it on THIS node, or null
 * when the node has no such way out.
 */
function outboundTagFor(target: EgressTarget, caps: NodeEgressCapabilities): string | null {
  switch (target) {
    case 'direct':
      return 'direct';
    case 'block':
      return 'blocked';
    case 'warp':
      return caps.warp ? 'warp' : null;
    case 'zapret2':
      return caps.zapret2SocksPort === null ? null : ZAPRET2_OUTBOUND_TAG;
  }
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

/**
 * Compile an authored policy against one node's capabilities.
 *
 * Rule order is preserved: xray takes the first matching rule, so the operator's
 * order is the precedence they see in the UI.
 *
 * domainStrategy: a rule that matches on IP can only fire once xray has resolved
 * the destination, and with sniffing on a flow is routed by its sniffed DOMAIN.
 * Under the default IPIfNonMatch xray resolves it only if NO rule matched, and a
 * node with a cascade or WARP catch-all always has a later rule that matches, so
 * the second pass never comes. Any ip/geoip matcher therefore pushes the whole
 * config to IPOnDemand, which resolves as a rule needs an IP. A domain-only
 * policy keeps the default, so it stays byte-identical to a node without one.
 */
export function compileEgressPolicy(
  policy: EgressPolicy | undefined,
  caps: NodeEgressCapabilities,
): CompiledEgressPolicy {
  if (!policy || policy.length === 0) return { fragments: null, dropped: [] };

  const rules: NonNullable<RoutingFragmentsCfg['rules']> = [];
  const dropped: DroppedRule[] = [];
  let needsIpResolution = false;

  policy.forEach((rule, index) => {
    const outboundTag = outboundTagFor(rule.target, caps);
    if (outboundTag === null) {
      dropped.push({
        index,
        target: rule.target,
        reason: `node has no ${rule.target} egress`,
      });
      return;
    }
    const domain = [...qualify('geosite', rule.geosite), ...(rule.domain ?? [])];
    const ip = [...qualify('geoip', rule.geoip), ...(rule.ip ?? [])];
    if (ip.length > 0) needsIpResolution = true;
    rules.push({
      ...(domain.length > 0 ? { domain } : {}),
      ...(ip.length > 0 ? { ip } : {}),
      ...(rule.port ? { port: rule.port } : {}),
      ...(rule.network ? { network: rule.network } : {}),
      outboundTag,
    });
  });

  if (rules.length === 0) return { fragments: null, dropped };

  const outbounds: unknown[] = [];
  if (rules.some((r) => r.outboundTag === ZAPRET2_OUTBOUND_TAG)) {
    // Non-null: a rule only carries this tag when the capability was present.
    outbounds.push(zapret2SocksOutbound(caps.zapret2SocksPort as number));
  }

  return {
    fragments: {
      rules,
      ...(outbounds.length > 0 ? { outbounds } : {}),
      ...(needsIpResolution ? { domainStrategy: 'IPOnDemand' as const } : {}),
    },
    dropped,
  };
}
