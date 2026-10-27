import { FORMAT_NAMES, formatDisabledForHost, type SubscriptionFormat } from '@iceslab/shared';
import { buildWgQuickConf } from './formats/wgconf.js';
import { buildAwgVpnLink } from './formats/amneziavpn.js';
import { outlineAccessKey } from './formats/outline.js';
import { endpointsForFormat, isPlainXray, type AmneziawgSubscriptionEndpoint, type SubscriptionEndpoint } from './subscription.formats.js';
import { endpointId } from './endpoint-identity.js';
import type { SubscriptionPageData } from './subscription.page.js';

export type PageHandouts = Required<
  Pick<SubscriptionPageData, 'protocols' | 'carriedFormats' | 'awgNodes' | 'mtprotoNodes' | 'telegramProxies' | 'outlineNodes'>
>;

/**
 * What the subscription page hands THIS person besides the link: the
 * protocols it offers apps for, the formats whose file would carry something,
 * and the per-node handouts (a tunnel per AmneziaWG node and device, a proxy
 * link per MTProto node, a Telegram proxy per endpoint, an Outline key per
 * Shadowsocks node).
 *
 * One function for the page and for every other surface that tells the person
 * how to connect (the install document of the compatibility API), so the two
 * cannot promise different things.
 *
 * `endpoints` are the public ones: hidden hosts out, narrowed by `?protocols=`
 * already. `format` is the one the request resolved to; a host switched off for
 * it is not on the page, as it is not in the file.
 */
export function pageHandouts(
  endpoints: readonly SubscriptionEndpoint[],
  format: SubscriptionFormat,
  subUrl: string,
): PageHandouts {
  const filtered = endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, format));
  const protocols = [...new Set(endpoints.map((e) => e.protocol))];

  // One QR pair per AmneziaWG node and device (deduped by node name and
  // device). wg-quick / vpn:// are single-tunnel-per-key, so a user with
  // several AWG servers gets each server's own labelled QR (.conf for the
  // AmneziaWG app, vpn:// for the AmneziaVPN app) instead of only the first
  // node's, and each of their devices its own key. ecl 'L' keeps the long
  // payloads scannable.
  const awgSeen = new Set<string>();
  const awgNodes = filtered
    .filter((e): e is AmneziawgSubscriptionEndpoint => e.protocol === 'amneziawg')
    .filter((e) => {
      const k = `${e.nodeName}\u0000${e.deviceIndex ?? 1}`;
      return !awgSeen.has(k) && !!awgSeen.add(k);
    })
    .map((e) => {
      // By the endpoint's id, the key the per-node links carry (A-107).
      const id = endpointId(e);
      const device = e.deviceIndex ?? 1;
      const conf = buildWgQuickConf(filtered, id, String(device));
      const vpn = buildAwgVpnLink(filtered, id, String(device));
      return {
        nodeName: e.nodeName,
        id,
        device,
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
  const mtprotoNodes = filtered
    .filter((e) => e.protocol === 'mtproto')
    .filter((e) => !mtSeen.has(e.nodeName) && !!mtSeen.add(e.nodeName))
    .map((e) => ({
      nodeName: e.nodeName,
      uri: (e as { uri?: string }).uri ?? '',
      tmeUri: (e as { tmeUri?: string }).tmeUri ?? '',
    }))
    .filter((n) => n.uri !== '');

  // SOCKS5 / HTTP for Telegram: one row per endpoint, not per node, and
  // no dedupe, because the login in each is this person's own.
  const telegramProxies = filtered.filter(isPlainXray).map((e) => ({
    nodeName: e.nodeName,
    kind: e.subprotocol,
    tgUri: e.tgUri,
    host: e.host,
    port: e.port,
    username: e.username,
    password: e.password,
  }));

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

  // A download row is offered exactly when its file would carry something:
  // the same gate and the same host switches the file itself goes through.
  const carriedFormats = FORMAT_NAMES.filter(
    (f) => endpointsForFormat(f, endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, f))).length > 0,
  );

  return { protocols, carriedFormats, awgNodes, mtprotoNodes, telegramProxies, outlineNodes };
}
