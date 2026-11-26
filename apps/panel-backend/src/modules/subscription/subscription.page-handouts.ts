import { formatDisabledForHost } from '@iceslab/shared';
import { getSubscriptionSettings } from '../settings/settings.service.js';
import {
  endpointsForFormat,
  type AmneziawgSubscriptionEndpoint,
  type SubscriptionEndpoint,
  type WireguardSubscriptionEndpoint,
} from './subscription.formats.js';
import { endpointId } from './endpoint-identity.js';
import { buildWgQuickConf, wgconfTunnelName, type WgClientOpts } from './formats/wgconf.js';
import { buildAwgVpnLink } from './formats/amneziavpn.js';
import { outlineAccessKey } from './formats/outline.js';
import type { SubscriptionPageData } from './subscription.page.js';

/**
 * What the panel settings add to every wg config it hands out: the resolvers,
 * the `::/0` switch and the brand the tunnel is named after (the title clients
 * show, then the brand, as the page's own title). One read for the file, the
 * vpn:// key and the page's codes, so they cannot disagree.
 */
export async function wgClientOpts(): Promise<WgClientOpts & { brand: string }> {
  const settings = await getSubscriptionSettings();
  return {
    dns: settings.wgDns,
    dropIpv6: settings.wgDropIpv6,
    brand: settings.profileTitle ?? settings.brandName ?? 'Iceslab',
  };
}

export interface PageHandouts {
  awgNodes: NonNullable<SubscriptionPageData['awgNodes']>;
  wgNodes: NonNullable<SubscriptionPageData['wgNodes']>;
  mtprotoNodes: NonNullable<SubscriptionPageData['mtprotoNodes']>;
  outlineNodes: NonNullable<SubscriptionPageData['outlineNodes']>;
}

/**
 * The per-node things a subscription hands out besides the link: the tunnel
 * configs and keys, the Telegram proxy links, the Outline keys. The page draws
 * them and the shop's install document (14.6) offers them, from this one
 * function, so the two cannot promise different things.
 *
 * `endpoints` is everything the subscription holds. `mtprotoFrom` is the list
 * the proxy links are taken from: the page passes the endpoints left after its
 * own format's host switches, the shop's document passes them all (the t.me link
 * fetches nothing back from us).
 */
export function pageHandouts(args: {
  endpoints: SubscriptionEndpoint[];
  mtprotoFrom: SubscriptionEndpoint[];
  subUrl: string;
  wgOpts: WgClientOpts & { brand: string };
}): PageHandouts {
  const { endpoints, mtprotoFrom, subUrl, wgOpts } = args;
  // The tunnel cards and codes follow the files they carry, not the format this
  // request happens to be (a browser's is `plain`): a host switched off for
  // wgconf has no .conf card and no QR here, and one switched off only for
  // plain keeps both. The vpn:// key is its own format.
  const wgconfEps = endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, 'wgconf'));
  const vpnEps = endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, 'amneziavpn'));
  // One QR pair per AmneziaWG node and device (deduped by node name and
  // device). wg-quick / vpn:// are single-tunnel-per-key, so a user with
  // several AWG servers gets each server's own labelled QR (.conf for the
  // AmneziaWG app, vpn:// for the AmneziaVPN app) instead of only the first
  // node's, and each of their devices its own key. ecl 'L' keeps the long
  // payloads scannable.
  const awgSeen = new Set<string>();
  const awgNodes = wgconfEps
    .filter((e): e is AmneziawgSubscriptionEndpoint => e.protocol === 'amneziawg')
    .filter((e) => {
      const k = `${e.nodeName}\u0000${e.deviceIndex ?? 1}`;
      return !awgSeen.has(k) && !!awgSeen.add(k);
    })
    .map((e) => {
      // By the endpoint's id, the key the per-node links carry (A-107).
      const id = endpointId(e);
      const device = e.deviceIndex ?? 1;
      const conf = buildWgQuickConf(wgconfEps, id, String(device), wgOpts);
      const vpn = buildAwgVpnLink(vpnEps, id, String(device), wgOpts);
      return {
        nodeName: e.nodeName,
        id,
        device,
        file: `${wgconfTunnelName(wgconfEps, wgOpts.brand, id, String(device))}.conf`,
        // The PAYLOADS, not pictures of them. The codes are drawn in the
        // browser now: three server-rendered SVGs cost about 49 KB gzip
        // on this page, the encoder costs 4.3 KB once, and the code on
        // the wire is the same code. See subscription.page-qr.ts.
        conf: conf || undefined,
        // Raw vpn:// key: also what the copy button hands over, since the
        // dense key QR is unreliable on screen and paste-the-key is the
        // robust path.
        vpnKey: vpn || undefined,
        // t07-6c: the page names the app version a 3.1 tunnel needs.
        ...((e as { geometry3?: unknown }).geometry3 ? { awg3: true } : {}),
      };
    });
  // Plain WireGuard (9.2): one conf per node, from the same builder as
  // the file (so the QR is what the download gives).
  const wgSeen = new Set<string>();
  const wgNodes = wgconfEps
    .filter((e): e is WireguardSubscriptionEndpoint => e.protocol === 'wireguard')
    .filter((e) => {
      const k = `${e.nodeName}\u0000${e.deviceIndex ?? 1}`;
      return !wgSeen.has(k) && !!wgSeen.add(k);
    })
    .map((e) => {
      const id = endpointId(e);
      const device = e.deviceIndex ?? 1;
      return {
        nodeName: e.nodeName,
        id,
        device,
        file: `${wgconfTunnelName(wgconfEps, wgOpts.brand, id, String(device))}.conf`,
        conf: buildWgQuickConf(wgconfEps, id, String(device), wgOpts) || undefined,
      };
    });
  /**
   * One row per MTProto node, with the link already built.
   *
   * The page showed a Telegram card with instructions and NO proxy link,
   * so the only way to actually use an MTProto node was to read the raw
   * subscription and find the `tg://` line by hand (issue #41). Both
   * forms exist on the endpoint already: `tg://` opens the app directly,
   * `https://t.me/proxy?...` works as a clickable link anywhere, which is
   * the one to hand somebody.
   *
   * Deduped by node, like the AmneziaWG files: mtg is single-secret per
   * inbound, so every user on that squad gets the same link, and a node
   * appearing twice would be the same link twice.
   */
  const mtSeen = new Set<string>();
  const mtprotoNodes = mtprotoFrom
    .filter((e) => e.protocol === 'mtproto')
    .filter((e) => !mtSeen.has(e.nodeName) && !!mtSeen.add(e.nodeName))
    .map((e) => ({
      nodeName: e.nodeName,
      uri: (e as { uri?: string }).uri ?? '',
      tmeUri: (e as { tmeUri?: string }).tmeUri ?? '',
    }))
    .filter((n) => n.uri !== '');
  // One Outline key per Shadowsocks node, as the AmneziaWG pairs: a key
  // carries one server. Through the same gate as the file itself, so a
  // node on a 2022-blake3 cipher, which Outline cannot read, gets no key.
  const ssSeen = new Set<string>();
  const outlineNodes = endpointsForFormat(
    'outline',
    endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, 'outline')),
  )
    .filter((e) => !ssSeen.has(e.nodeName) && !!ssSeen.add(e.nodeName))
    .flatMap((e) => {
      const key = outlineAccessKey(subUrl, endpointId(e), e.nodeName);
      return key ? [{ nodeName: e.nodeName, key }] : [];
    });
  return { awgNodes, wgNodes, mtprotoNodes, outlineNodes };
}
