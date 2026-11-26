import type { SubscriptionEndpoint } from './subscription.formats.js';

/**
 * The one place that answers "do the exits of this document have IPv6", and the
 * one place that turns the answer into the address-family strategy of a DNS
 * block. The split-DNS blocks of xray-json and sing-box read it; neither spells
 * a strategy of its own, so the two formats cannot disagree about the same
 * document.
 *
 * Until stage 18 nothing records an exit's IPv6, so the answer is always "no":
 * every path handed out is IPv4 end to end, and an AAAA answer would name a
 * route the tunnel cannot carry. TODO(m18.7): the real source replaces the body
 * of `exitsHaveIpv6` and nothing else; the signature (the document's points in,
 * a flag out) stays.
 */
export function exitsHaveIpv6(points: readonly SubscriptionEndpoint[]): boolean {
  void points;
  return false;
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
