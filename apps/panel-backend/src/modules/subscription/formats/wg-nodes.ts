// The per-node tunnel list, shared by every surface that has to show it.
//
// WireGuard and AmneziaWG are single-tunnel-per-file: one .conf (and, for
// AmneziaWG, one AmneziaVPN `vpn://` key) per NODE, not one per subscription. So
// every surface that offers them has to walk the endpoints, dedupe by node in
// the order the subscription lists them, and render each node's artefacts.
//
// That walk used to live inline in `subscription.routes.ts`, where only our own
// HTML page could reach it. The shop's install screen needs the identical list —
// same nodes, same order, same keys — or a buyer following the shop's screen and
// a buyer following ours are handed different servers.

import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { buildWgQuickConf } from './wgconf.js';
import { buildAwgVpnLink } from './amneziavpn.js';

export type WgFlavour = 'amneziawg' | 'wireguard';

export interface WgNode {
  nodeName: string;
  /** wg-quick config for this node, or null when it could not be built. */
  conf: string | null;
  /** AmneziaVPN `vpn://` key. AmneziaWG only — stock WireGuard has no key form,
   *  its .conf is the whole import path. */
  vpnKey: string | null;
}

/**
 * One entry per node serving `flavour`, in subscription order.
 *
 * Deduped by node NAME because that is what selects the tunnel downstream:
 * `?node=` on wgconf/amneziavpn resolves by name, so two endpoints sharing a
 * name are one downloadable file however many hosts produced them.
 */
export function collectWgNodes(
  endpoints: SubscriptionEndpoint[],
  flavour: WgFlavour,
): WgNode[] {
  const seen = new Set<string>();
  return endpoints
    .filter((e) => e.protocol === flavour)
    .filter((e) => !seen.has(e.nodeName) && !!seen.add(e.nodeName))
    .map((e) => {
      const conf = buildWgQuickConf(endpoints, e.nodeName, flavour);
      const vpn = flavour === 'amneziawg' ? buildAwgVpnLink(endpoints, e.nodeName) : '';
      return {
        nodeName: e.nodeName,
        conf: conf || null,
        vpnKey: vpn || null,
      };
    });
}
