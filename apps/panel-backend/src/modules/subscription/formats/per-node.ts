// Config artefacts that exist once per NODE, shared by every surface that shows
// them.
//
// Some protocols cannot be handed over as one subscription. WireGuard and
// AmneziaWG are single-tunnel-per-file: one .conf (and, for AmneziaWG, one
// AmneziaVPN `vpn://` key) per node. MTProto is one `t.me/proxy` link per node,
// because Telegram is the client and it imports one proxy at a time. Either way
// the surface has to walk the endpoints, dedupe by node in the order the
// subscription lists them, and render each node's own artefact.
//
// That walk used to live inline in `subscription.routes.ts`, where only our own
// HTML page could reach it. The shop's install screen needs the identical list —
// same nodes, same order, same keys — or a buyer following the shop's screen and
// a buyer following ours are handed different servers.

import type {
  MtprotoSubscriptionEndpoint,
  SubscriptionEndpoint,
} from '../subscription.formats.js';
import { buildWgQuickConf, wgConfName } from './wgconf.js';
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
 *
 * `opts` is passed straight to the config builder. It has to be a parameter and
 * not a lookup here: this walk feeds BOTH our own page and the shop's install
 * screen, and a config that differs between the two by a `DNS =` line — or by
 * the tunnel name — is a support call nobody can reproduce.
 */
export function collectWgNodes(
  endpoints: SubscriptionEndpoint[],
  flavour: WgFlavour,
  opts?: { dns?: string[]; brand?: string },
): WgNode[] {
  const seen = new Set<string>();
  return endpoints
    .filter((e) => e.protocol === flavour)
    .filter((e) => !seen.has(e.nodeName) && !!seen.add(e.nodeName))
    .map((e) => {
      const conf = buildWgQuickConf(endpoints, e.nodeName, flavour, {
        dns: opts?.dns,
        // Same name the download link's file name carries, from the same
        // function: a QR scan and a file download must not produce two
        // differently-named tunnels to one server.
        name: opts?.brand ? wgConfName(opts.brand, e.nodeName, flavour) : undefined,
      });
      // The flavour check states intent and changes nothing: buildAwgVpnLink
      // filters to `amneziawg` itself, so a WireGuard node gets '' either way.
      // Kept as the readable half of that fact, not as a guard anything leans
      // on — removing it cannot alter a single output.
      const vpn = flavour === 'amneziawg' ? buildAwgVpnLink(endpoints, e.nodeName, opts?.dns) : '';
      return {
        nodeName: e.nodeName,
        conf: conf || null,
        vpnKey: vpn || null,
      };
    });
}

/**
 * Where an endpoint's config lives when the endpoint has no share-link.
 *
 * `plain` is a list of client URIs, and the two WireGuard flavours have none
 * to give — `subscription.service.ts` emits `uri: ''` for both. A
 * buyer holding only those gets an empty `plain`, which is the honest answer
 * for that format (a machine asked for proxy URIs and there are none) but a
 * dead end for anything trying to find out what they DO have.
 *
 * So `json`, the format that describes a subscription rather than feeding a
 * proxy client, names the files instead. Returns undefined for a protocol whose
 * config rides in the subscription — there the `uri` already is the answer.
 */
export function tunnelConfigUrls(
  e: SubscriptionEndpoint,
  subUrl: string,
): Record<string, string> | undefined {
  const node = encodeURIComponent(e.nodeName);
  if (e.protocol === 'amneziawg') {
    return {
      // wg-quick / AmneziaWG file, and the AmneziaVPN app's own key form.
      wgconf: `${subUrl}?format=wgconf&proto=amneziawg&node=${node}`,
      amneziavpn: `${subUrl}?format=amneziavpn&node=${node}`,
    };
  }
  if (e.protocol === 'wireguard') {
    // Stock WireGuard has no key form; the .conf is the whole import path.
    return { wgconf: `${subUrl}?format=wgconf&proto=wireguard&node=${node}` };
  }
  return undefined;
}


export interface MtprotoNode {
  nodeName: string;
  /** `https://t.me/proxy?server=…&port=…&secret=…` — the link Telegram itself
   *  turns into a "connect to this proxy" prompt. */
  tmeUri: string;
}

/**
 * One entry per node serving MTProto, in subscription order.
 *
 * The `t.me` form rather than `tg://proxy`: the shop's MiniApp routes an http(s)
 * button through `openLink` and only reaches `openTelegramLink` on a `tg://`
 * value it then passes verbatim — and `openTelegramLink` is documented to take a
 * t.me URL. A browser handles `t.me` too, so one link serves both surfaces.
 */
export function collectMtprotoNodes(endpoints: SubscriptionEndpoint[]): MtprotoNode[] {
  const seen = new Set<string>();
  return endpoints
    .filter((e): e is MtprotoSubscriptionEndpoint => e.protocol === 'mtproto')
    .filter((e) => !seen.has(e.nodeName) && !!seen.add(e.nodeName))
    .filter((e) => !!e.tmeUri)
    .map((e) => ({ nodeName: e.nodeName, tmeUri: e.tmeUri }));
}
