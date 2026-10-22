import { isIP } from 'node:net';

/**
 * A leg dials its next hop over the address family its OWN address has in the
 * panel (A-111, IPv6 part, decision 23.10: option a).
 *
 * The next hop's firewall lets the leg in only from the previous hop's address
 * as the panel knows it (linkIngress.allowFrom). When that is an IPv4 literal
 * and the next hop is named by a hostname with an AAAA record, the leg's
 * outbound resolves the name and may dial over IPv6: the connection then
 * arrives from the previous hop's IPv6 address, which no rule names, and ufw
 * drops it without a word. So the dial is pinned to the family the rule was
 * written for:
 *   - sing-box 1.13, dial field `domain_resolver` with a `strategy`
 *     (sing-box.sagernet.org/configuration/shared/dial: `domain_strategy` is
 *     deprecated since 1.12 and replaced by `domain_resolver`, which "uses the
 *     same format as the route DNS rule action": `server` and `strategy`,
 *     `ipv4_only` | `ipv6_only`; read 2026-10-23). The `strategy` is itself
 *     marked deprecated in 1.14, to revisit with the pin;
 *   - xray, `streamSettings.sockopt.domainStrategy` `ForceIPv4` | `ForceIPv6`
 *     (Xray-docs-next config/transports/sockopt.md: a `Use*` value falls back
 *     to AsIs when resolution does not match, a `Force*` one fails instead;
 *     for vless and shadowsocks it applies to the server's domain name).
 *
 * Nothing is pinned when the previous hop is named by a hostname (the agent
 * resolves it into every A and AAAA, so either family is let in), nor when the
 * next hop is a literal (nothing to resolve, the family is the literal's).
 */
export type DialFamily = 4 | 6;

/** The family to pin a leg out of `selfHost` to `peerHost` to, or undefined. */
export function dialFamilyOf(selfHost: string | undefined, peerHost: string): DialFamily | undefined {
  if (!selfHost || isIP(peerHost) !== 0) return undefined;
  const v = isIP(selfHost);
  return v === 4 ? 4 : v === 6 ? 6 : undefined;
}

/** sing-box's own DNS server for the legs' domain_resolver. */
export const LEG_DNS_TAG = 'leg-dns';

export function singboxDialFields(family: DialFamily | undefined): Record<string, unknown> {
  if (!family) return {};
  return { domain_resolver: { server: LEG_DNS_TAG, strategy: family === 4 ? 'ipv4_only' : 'ipv6_only' } };
}

/** An xray link outbound with its dial pinned, a copy; the shared sockopt is not touched. */
export function withXrayDialFamily(
  outbound: Record<string, unknown>,
  family: DialFamily | undefined,
): Record<string, unknown> {
  if (!family) return outbound;
  const stream = (outbound.streamSettings ?? {}) as Record<string, unknown>;
  const sockopt = (stream.sockopt ?? {}) as Record<string, unknown>;
  return {
    ...outbound,
    streamSettings: { ...stream, sockopt: { ...sockopt, domainStrategy: family === 4 ? 'ForceIPv4' : 'ForceIPv6' } },
  };
}
