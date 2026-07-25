import { z } from 'zod';

/**
 * E - server-side geo split on the cascade ENTRY hop. Pure + testable: compiles
 * an operator-authored egress policy (category/literal match -> target) into the
 * xray routing-rule objects that cascade.config.ts prepends ahead of the entry's
 * catch-all (user -> link-out / balancer). An absent/empty policy yields no
 * rules, so the entry stays byte-identical to a non-geo cascade.
 *
 * The node already honours geosite:/geoip: rules (sniffing + domainStrategy
 * IPIfNonMatch are on in xray/config.go) and merges CascadeFragments.routingRules
 * verbatim, so no node-agent change is needed for standard (xray-bundled)
 * categories. Custom categories (a downloaded ext:<file>.dat) reuse the same
 * rule shape with an `ext:` matcher in `domain`/`ip`.
 */

// A single matcher token (a geosite/geoip category name or a literal
// domain/ip). Bounded to keep an authored policy from ballooning the wire.
const Matcher = z.string().min(1).max(256);

/** Where a matched flow egresses from the entry hop. Extend as more entry
 *  outbounds land (e.g. a desync SOCKS or a WARP outbound). */
export const EgressTargetSchema = z.enum(['direct', 'block', 'link-out']);

export const EgressRuleSchema = z
  .object({
    /** geosite category names (xray-bundled or `ext:file.dat:cat`); prefixed
     *  `geosite:` unless already qualified (contains a colon). */
    geosite: z.array(Matcher).max(512).optional(),
    /** geoip category names (e.g. 'ru', 'private'); prefixed `geoip:` unless
     *  already qualified. */
    geoip: z.array(Matcher).max(512).optional(),
    /** Literal domain matchers, passed through verbatim (e.g. 'example.com',
     *  'domain:foo', 'ext:f.dat:c'). */
    domain: z.array(Matcher).max(4096).optional(),
    /** Literal IP/CIDR matchers, passed through verbatim (e.g. '10.0.0.0/8'). */
    ip: z.array(Matcher).max(4096).optional(),
    /** xray port matcher (e.g. '443', '1000-2000', '80,443'). */
    port: z
      .string()
      .regex(/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/)
      .optional(),
    /** Restrict the rule to a transport. */
    network: z.enum(['tcp', 'udp', 'tcp,udp']).optional(),
    target: EgressTargetSchema,
  })
  .refine(
    (r) =>
      Boolean(r.geosite?.length || r.geoip?.length || r.domain?.length || r.ip?.length || r.port),
    { message: 'each egress rule needs at least one matcher (geosite/geoip/domain/ip/port)' },
  );

export const EgressPolicySchema = z.array(EgressRuleSchema).max(128);

export type EgressTarget = z.infer<typeof EgressTargetSchema>;
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

/** The xray routing-rule fragment to merge for each target: `{ outboundTag }`
 *  for a fixed outbound, or `{ balancerTag }` on a balancer entry. */
export type TargetRouting = Record<EgressTarget, Record<string, unknown>>;

/**
 * Defensively coerce a persisted `Cascade.egressPolicy` (Prisma JsonValue) into
 * an EgressPolicy, or undefined if absent/malformed (data drift) - the caller
 * then renders a plain cascade rather than shipping a half-valid policy.
 */
export function coerceEgressPolicy(raw: unknown): EgressPolicy | undefined {
  if (raw == null) return undefined;
  const parsed = EgressPolicySchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

export interface CompiledEntryGeo {
  /** Field rules to PREPEND before the entry catch-all. */
  rules: Record<string, unknown>[];
  /** True when any rule targets 'block' (the caller must add a blackhole outbound). */
  needsBlock: boolean;
}

// A colon means the matcher is already qualified (geosite:/geoip:/ext:/domain:/
// full:/regexp:/keyword:) or is an IPv6 literal - leave it untouched.
const QUALIFIED = /:/;

function geositeMatchers(cats: string[] | undefined): string[] {
  return (cats ?? []).map((c) => (QUALIFIED.test(c) ? c : `geosite:${c}`));
}

function geoipMatchers(cats: string[] | undefined): string[] {
  return (cats ?? []).map((c) => (QUALIFIED.test(c) ? c : `geoip:${c}`));
}

/**
 * Compile an egress policy into entry-hop field rules. `targets` maps each
 * EgressTarget to the routing fragment that steers a match there (so the same
 * compiler serves a chain entry, where 'link-out' is `{outboundTag}`, and a
 * balancer entry, where it is `{balancerTag}`).
 *
 * IP/geoip ON THE ENTRY (pending live s1 validation of the IPOnDemand path):
 * the entry inbound sniffs (destOverride) so a TLS/HTTP/QUIC connection's routing
 * target becomes the sniffed DOMAIN. Under the default routing.domainStrategy=
 * IPIfNonMatch xray only resolves the domain to an IP for a second rule pass IF
 * NO rule matched the first - but cascade.config.ts appends an always-true
 * network catch-all to link-out/balancer, which matches first, so an `ip`/geoip:
 * rule would never get that second pass. FIX: when a policy has an ip/geoip
 * matcher, the entry fragments carry DomainStrategy='IPOnDemand'
 * (entryDomainStrategy below), which resolves on demand as a rule needs an IP, so
 * the ip/geoip rules (emitted BEFORE the catch-all) fire. A geosite:/domain:-only
 * policy keeps the default strategy (byte-identical). CAVEAT to validate on s1:
 * IPOnDemand resolves the sniffed domain through the node's DNS, which may return
 * a different IP than the client connects to (CDN / geo-DNS), so a geoip match
 * can be approximate; confirm on a live xray before relying on geoip splits.
 */
/**
 * True when the policy has any ip/geoip matcher, i.e. a rule that can only be
 * evaluated once xray has resolved the connection's destination to an IP. Such a
 * policy needs the entry's routing.domainStrategy overridden to `IPOnDemand`
 * (see the "IP/geoip ON THE ENTRY" note on compileEntryGeoRules) - the caller
 * sets DomainStrategy on the entry fragments accordingly. A geosite:/domain:-only policy returns
 * false, so its entry keeps the default strategy (no behaviour change).
 */
export function policyNeedsIpResolution(policy: EgressPolicy | undefined): boolean {
  return (policy ?? []).some((r) => Boolean(r.geoip?.length || r.ip?.length));
}

/** The xray routing.domainStrategy an entry must use for its egress policy, or
 *  undefined to keep the node default. IPOnDemand only when an ip/geoip matcher
 *  is present (it resolves on demand so those rules fire before the catch-all). */
export function entryDomainStrategy(policy: EgressPolicy | undefined): 'IPOnDemand' | undefined {
  return policyNeedsIpResolution(policy) ? 'IPOnDemand' : undefined;
}

export function compileEntryGeoRules(
  policy: EgressPolicy | undefined,
  targets: TargetRouting,
): CompiledEntryGeo {
  const rules: Record<string, unknown>[] = [];
  let needsBlock = false;
  for (const r of policy ?? []) {
    const domain = [...geositeMatchers(r.geosite), ...(r.domain ?? [])];
    const ip = [...geoipMatchers(r.geoip), ...(r.ip ?? [])];
    // A rule with no matcher at all would behave as a catch-all and shadow the
    // real catch-all below it; drop it so an empty/misconfigured rule cannot
    // silently hijack every connection.
    if (domain.length === 0 && ip.length === 0 && r.port === undefined) continue;
    const base: Record<string, unknown> = { type: 'field' };
    if (r.port !== undefined) base.port = r.port;
    if (r.network !== undefined) base.network = r.network;
    Object.assign(base, targets[r.target]);
    if (r.target === 'block') needsBlock = true;
    // xray ANDs the conditions inside one rule, so domain+ip together would
    // demand BOTH to match (the classic geosite+geoip-in-one-rule trap). The
    // policy means "any of these -> target", so emit them as separate rules.
    if (domain.length > 0) rules.push({ ...base, domain });
    if (ip.length > 0) rules.push({ ...base, ip });
    if (domain.length === 0 && ip.length === 0) rules.push(base); // port/network-only
  }
  return { rules, needsBlock };
}
