import { buildAmneziawgClientConfig } from '../../../core-adapters/amneziawg/index.js';
import { buildWireguardClientConfig } from '../../../core-adapters/wireguard/index.js';
import type {
  SubscriptionEndpoint,
  AmneziawgSubscriptionEndpoint,
  WireguardSubscriptionEndpoint,
} from '../subscription.formats.js';

/** The two wg-quick-shaped protocols this format can emit. */
export type WgFlavour = 'amneziawg' | 'wireguard';

type WgEndpoint = AmneziawgSubscriptionEndpoint | WireguardSubscriptionEndpoint;

function isWgEndpoint(e: SubscriptionEndpoint): e is WgEndpoint {
  return e.protocol === 'amneziawg' || e.protocol === 'wireguard';
}

/**
 * wg-quick / awg-quick `.conf` subscription formatter.
 *
 * Targets the AmneziaVPN-app and the AmneziaWG mobile clients for
 * `amneziawg` endpoints, and stock WireGuard (official apps, WireSock,
 * kernel `wg-quick`) for `wireguard` ones. The two produce different text:
 * an AmneziaWG config carries the Jc/S/H obfuscation directives, and stock
 * wireguard-tools refuses the file outright when it meets one (`Line
 * unrecognized: 'Jc=4'`, then wg-quick deletes the device), so the flavour
 * decides the builder rather than adding optional lines to one blob.
 *
 * Limitations:
 *   - **Single tunnel per file.** wg-quick is one [Interface] per file; a
 *     client can't merge several tunnels into one config. A user with more
 *     than one wg node therefore needs one link per node: pass `nodeName` to
 *     pick which endpoint to emit. Without it (the legacy whole-subscription
 *     link) we emit the first wg endpoint, so every per-node link MUST carry
 *     `?node=` or they all resolve to the same node.
 *   - **wg-family only.** hysteria/xray/naive endpoints are skipped silently.
 *     The client picked this format because their app speaks wg-quick; other
 *     protocols don't translate to it.
 *
 * `flavour` disambiguates a node that serves both protocols (each is its own
 * tunnel with its own subnet and port); omitted, the first match wins.
 *
 * Returns an empty string when no matching endpoint is available, the route
 * handler turns that into a 204-style empty body, telling the client "no
 * wg inbound configured for you".
 */
export function buildWgQuickConf(
  endpoints: SubscriptionEndpoint[],
  nodeName?: string,
  flavour?: WgFlavour,
): string {
  let candidates = endpoints.filter(isWgEndpoint);
  if (flavour) {
    candidates = candidates.filter((e) => e.protocol === flavour);
  }
  // nodeName selects which node's tunnel; absent = first (legacy whole-sub link).
  const wg = nodeName ? candidates.find((e) => e.nodeName === nodeName) : candidates[0];
  if (!wg) return '';

  if (wg.protocol === 'wireguard') {
    return buildWireguardClientConfig({
      privateKey: wg.privateKey,
      allowedIp: wg.allowedIp,
      serverPublicKey: wg.serverPublicKey,
      host: wg.host,
      port: wg.port,
    });
  }

  return buildAmneziawgClientConfig({
    privateKey: wg.privateKey,
    allowedIp: wg.allowedIp,
    serverPublicKey: wg.serverPublicKey,
    host: wg.host,
    port: wg.port,
    jc: wg.jc,
    jmin: wg.jmin,
    jmax: wg.jmax,
    s1: wg.s1,
    s2: wg.s2,
    s3: wg.s3,
    s4: wg.s4,
    h1: wg.h1,
    h2: wg.h2,
    h3: wg.h3,
    h4: wg.h4,
    i1: wg.i1,
    i2: wg.i2,
    i3: wg.i3,
    i4: wg.i4,
    i5: wg.i5,
  });
}
