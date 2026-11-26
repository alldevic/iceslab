import { buildAmneziawgClientConfig } from '../../../core-adapters/amneziawg/index.js';
import { buildWireguardClientConfig } from '../../../core-adapters/wireguard/index.js';
import type {
  SubscriptionEndpoint,
  AmneziawgSubscriptionEndpoint,
  WireguardSubscriptionEndpoint,
} from '../subscription.formats.js';
import { pickServer } from '../endpoint-identity.js';

export type WgconfEndpoint = AmneziawgSubscriptionEndpoint | WireguardSubscriptionEndpoint;

/** The tunnel a wgconf answer is built from, or undefined when there is none. */
export function pickWgconfEndpoint(
  endpoints: SubscriptionEndpoint[],
  node?: string,
): WgconfEndpoint | undefined {
  const awg = endpoints.filter((e): e is AmneziawgSubscriptionEndpoint => e.protocol === 'amneziawg');
  const wg = endpoints.filter((e): e is WireguardSubscriptionEndpoint => e.protocol === 'wireguard');
  // `node` selects which tunnel, by its id or its label; absent = first
  // (legacy whole-sub link), the AmneziaWG one while there is one. See pickServer.
  if (!node) return pickServer(awg) ?? pickServer(wg);
  return pickServer<WgconfEndpoint>([...awg, ...wg], node);
}

/**
 * wg-quick / awg-quick `.conf` subscription formatter (AmneziaWG, and plain
 * WireGuard since 9.2: each has its own builder, chosen by the protocol of the
 * endpoint, so no AmneziaWG directive can reach a stock WireGuard client).
 *
 * Targets the AmneziaVPN-app, the AmneziaWG mobile clients, and stock
 * `wg-quick` for users on AmneziaWG-aware kernels. Output is the textual
 * `[Interface]` + `[Peer]` blob produced by `buildAmneziawgClientConfig`.
 *
 * Limitations:
 *   - **Single node per file.** wg-quick is one [Interface] per file; a client
 *     can't merge several AmneziaWG tunnels into one config. A user with more
 *     than one AmneziaWG node therefore needs one link per node: pass
 *     `node` (the endpoint's id, or its label as older links carry) to pick
 *     which endpoint to emit. Without it (the legacy
 *     whole-subscription link) we emit the first AmneziaWG endpoint, so every
 *     per-node link MUST carry `?node=` or they all resolve to the same node.
 *   - **AmneziaWG-only.** hysteria/xray/naive endpoints are skipped silently.
 *     The client picked this format because their app speaks wg-quick; other
 *     protocols don't translate to it.
 *
 * Without `node` the AmneziaWG tunnel is the answer when the subscription has
 * both (what the format always gave); `?protocols=wireguard` narrows the
 * endpoints to the plain one before this runs.
 *
 * Returns an empty string when no matching AmneziaWG endpoint is available, the
 * route handler turns that into a 204-style empty body, telling the client
 * "no AmneziaWG inbound configured for you".
 */
export function buildWgQuickConf(
  endpoints: SubscriptionEndpoint[],
  node?: string,
): string {
  const picked = pickWgconfEndpoint(endpoints, node);
  if (!picked) return '';
  if (picked.protocol === 'wireguard') {
    return buildWireguardClientConfig({
      privateKey: picked.privateKey,
      allowedIp: picked.allowedIp,
      serverPublicKey: picked.serverPublicKey,
      host: picked.host,
      port: picked.port,
    });
  }
  const awg = picked;
  return buildAmneziawgClientConfig({
    privateKey: awg.privateKey,
    allowedIp: awg.allowedIp,
    serverPublicKey: awg.serverPublicKey,
    host: awg.host,
    port: awg.port,
    jc: awg.jc,
    jmin: awg.jmin,
    jmax: awg.jmax,
    s1: awg.s1,
    s2: awg.s2,
    s3: awg.s3,
    s4: awg.s4,
    h1: awg.h1,
    h2: awg.h2,
    h3: awg.h3,
    h4: awg.h4,
    i1: awg.i1,
    i2: awg.i2,
    i3: awg.i3,
    i4: awg.i4,
    i5: awg.i5,
    ...(awg.geometry3 ? { geometry3: awg.geometry3 } : {}),
  });
}
