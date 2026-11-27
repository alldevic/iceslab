import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * The one place that answers "do the exits of this document have IPv6", and the
 * one place that turns the answer into the address-family strategy of a DNS
 * block. The split-DNS blocks of xray-json and sing-box read it; neither spells
 * a strategy of its own, so the two formats cannot disagree about the same
 * document.
 *
 * An exit has IPv6 when `exitHasIpv6` is set on its point (the service sets it
 * from the node's fact and mode, and for the entry of a cascade from the fact of
 * its exits, see nodeExitsViaIpv6); a point that carries no flag has none. The
 * rule is "at least one exit" (decision 4 of PLAN-ipv6 C), not "all": through an
 * exit without IPv6 a site with an AAAA record may open late, accepted.
 */
export function exitsHaveIpv6(points: readonly SubscriptionEndpoint[]): boolean {
  return points.some((p) => p.exitHasIpv6 === true);
}

/**
 * The `dns:` block of a clash-family config with `ipv6: true` after `enable:`
 * when the exits have IPv6; without, the lines come back as they are, byte for
 * byte. A block of the operator's own template is never passed through here.
 */
export function clashDnsLines(lines: readonly string[], hasIpv6: boolean): readonly string[] {
  if (!hasIpv6) return lines;
  const at = lines.indexOf('  enable: true');
  if (at === -1) return lines;
  return [...lines.slice(0, at + 1), '  ipv6: true', ...lines.slice(at + 1)];
}

/** xray `dns.queryStrategy`: IPv4 records only while no exit can carry IPv6. */
export function xrayQueryStrategy(hasIpv6: boolean): 'UseIP' | 'UseIPv4' {
  return hasIpv6 ? 'UseIP' : 'UseIPv4';
}

/**
 * sing-box `dns.strategy`: prefer IPv4 while no exit can carry IPv6; with IPv6
 * the key is left out, which is sing-box's own default (both families).
 */
export function singboxDnsStrategy(hasIpv6: boolean): 'prefer_ipv4' | undefined {
  return hasIpv6 ? undefined : 'prefer_ipv4';
}
