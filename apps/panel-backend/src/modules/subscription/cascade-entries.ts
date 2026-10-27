import { isPlainXray, type SubscriptionEndpoint } from './subscription.formats.js';
import { endpointKey } from './endpoint-identity.js';

/**
 * A4: the UUID with its bytes 7-8 (the third group) set to `tag`. xray's VLESS
 * inbound lets a client change those two bytes freely and reads them as the
 * routing field `vlessRoute`, a big-endian uint16 (Xray-docs-next
 * config/routing.md, read 26.10), which is how the entry of a balancer cascade
 * sends each route profile to its own exit. A malformed UUID comes back as is.
 */
export function withVlessRouteTag(uuid: string, tag: number): string {
  const parts = uuid.split('-');
  if (parts.length !== 5 || parts[2]!.length !== 4) return uuid;
  parts[2] = (tag & 0xffff).toString(16).padStart(4, '0');
  return parts.join('-');
}

/**
 * One endpoint per route of a balancer-cascade entry (`cascadeExits`), the one
 * rule for every format that hands out an entry: the share links, Clash
 * (mihomo, stash, clash-legacy), sing-box and the xray-json array.
 *
 * Each copy is the entry with the route's tag in the UUID, named by the
 * route's label (`routeLabel`, unique across the subscription after
 * disambiguateCascadeLabels) and keyed apart from its siblings. The entry
 * without a tag is not handed out beside them: its bare UUID matches no route
 * and leaves from the entry itself.
 *
 * VLESS only. `vlessRoute` is a VLESS field: a trojan password or a vmess UUID
 * with two bytes changed is another credential and the entry refuses it. Those
 * entries go out once, untagged, as they always reached the entry.
 */
export function expandCascadeEntry(e: SubscriptionEndpoint): SubscriptionEndpoint[] {
  if (
    e.protocol !== 'xray' ||
    isPlainXray(e) ||
    (e.subprotocol ?? 'vless') !== 'vless' ||
    !e.cascadeExits ||
    e.cascadeExits.length === 0
  ) {
    return [e];
  }
  const hashIdx = e.uri.indexOf('#');
  const base = hashIdx === -1 ? e.uri : e.uri.slice(0, hashIdx);
  const key = endpointKey(e);
  return e.cascadeExits.map((route) => {
    const uuid = withVlessRouteTag(e.uuid, route.tag);
    return {
      ...e,
      uuid,
      nodeName: route.label,
      routeLabel: route.label,
      key: `${key}|route-${route.tag}`,
      // vless:// carries the UUID in the userinfo, so the first occurrence is it.
      uri: e.uri ? `${base.replace(e.uuid, uuid)}#${encodeURIComponent(route.label)}` : e.uri,
      cascadeExits: undefined,
    };
  });
}
