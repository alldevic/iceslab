import { formatDisabledForHost } from '@iceslab/shared';
import type { SubscriptionEndpoint } from './subscription.formats.js';
import { endpointId } from './endpoint-identity.js';
import { withProtocols } from './subscription.protocols.js';

/**
 * The query that names ONE tunnel of a subscription: its node (the endpoint's
 * id, A-107, or the label when the page has no id) and, from the second device
 * on, `device=` (9.4). Device 1 is what a link without it means, so its links
 * stay what they were. The page's own per-node links, the `json` format and the
 * shop's links all go through here.
 */
export function tunnelQuery(n: { nodeName: string; id?: string; device?: number }): string {
  const device = (n.device ?? 1) > 1 ? `&device=${n.device}` : '';
  return `node=${encodeURIComponent(n.id ?? n.nodeName)}${device}`;
}

/**
 * The `.conf` file of ONE tunnel: `subUrl` + `format=wgconf` + the tunnel's
 * query, with plain WireGuard naming its kind (`protocols=wireguard`). The
 * addresses of `tunnelConfigUrls` and the shop's download buttons (14.7) are
 * this one string. The caller has already left out a host switched off for
 * `wgconf`.
 */
export function tunnelFileUrl(
  subUrl: string,
  protocol: 'amneziawg' | 'wireguard',
  n: { nodeName: string; id?: string; device?: number },
): string {
  const url = `${subUrl}?format=wgconf&${tunnelQuery(n)}`;
  return protocol === 'wireguard' ? withProtocols(url, ['wireguard']) : url;
}

/**
 * The subscription page opened on ONE tunnel's QR: the preselect link
 * (`wantsTunnelPreselect`) with the `#scan` anchor. The shop's "Or scan a QR
 * code" button (14.7) opens it. No `format=`: it is the page a browser gets.
 */
export function tunnelScanUrl(
  subUrl: string,
  n: { nodeName: string; id?: string; device?: number },
): string {
  return `${subUrl}?${tunnelQuery(n)}#scan`;
}

/**
 * The addresses of the files a tunnel endpoint hands out, `configUrls` of the
 * `json` format: `wgconf` (wg-quick, any WireGuard client) and, for AmneziaWG,
 * `amneziavpn` (the vpn:// key). `subUrl` is the subscription address, no
 * query. Plain WireGuard names its kind the way 9.2 made it: `protocols=wireguard`,
 * so the link reads as the plain tunnel it is.
 *
 * A file the host is switched off for is not named, because the route would
 * not give it (`formatDisabledForHost`). Undefined for an endpoint that is not
 * a tunnel, or has no file left to name. The shop's document (14.7) builds its
 * links with this function.
 */
export function tunnelConfigUrls(
  subUrl: string,
  e: SubscriptionEndpoint,
): { wgconf?: string; amneziavpn?: string } | undefined {
  if (e.protocol !== 'amneziawg' && e.protocol !== 'wireguard') return undefined;
  const q = tunnelQuery({ nodeName: e.nodeName, id: endpointId(e), device: e.deviceIndex });
  const urls: { wgconf?: string; amneziavpn?: string } = {};
  if (!formatDisabledForHost(e.disableForFormats, 'wgconf')) {
    urls.wgconf = tunnelFileUrl(subUrl, e.protocol, {
      nodeName: e.nodeName,
      id: endpointId(e),
      device: e.deviceIndex,
    });
  }
  if (e.protocol === 'amneziawg' && !formatDisabledForHost(e.disableForFormats, 'amneziavpn')) {
    urls.amneziavpn = `${subUrl}?format=amneziavpn&${q}`;
  }
  return urls.wgconf || urls.amneziavpn ? urls : undefined;
}

/**
 * A link that names a tunnel (`?node=`, with `device=` from the second): the
 * page opens on that tunnel's QR (the shop's "scan" link, 14.7), and a portal
 * redirect leaves it alone. `protocols=` alone is a narrowing of every
 * subscription, not a tunnel, and is not one.
 */
export function wantsTunnelPreselect(query: { node?: string }): boolean {
  return !!query.node;
}

/** An endpoint of the `json` answer with its `configUrls`, when it has any. */
export function withConfigUrls(subUrl: string): <E extends SubscriptionEndpoint>(e: E) => E | (E & { configUrls: object }) {
  return (e) => {
    const configUrls = tunnelConfigUrls(subUrl, e);
    return configUrls ? { ...e, configUrls } : e;
  };
}
