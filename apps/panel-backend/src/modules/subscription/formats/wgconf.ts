import { buildAmneziawgClientConfig } from '../../../core-adapters/amneziawg/index.js';
import { buildWireguardClientConfig } from '../../../core-adapters/wireguard/index.js';
import type {
  SubscriptionEndpoint,
  AmneziawgSubscriptionEndpoint,
  WireguardSubscriptionEndpoint,
} from '../subscription.formats.js';

/** The two wg-quick-shaped protocols this format can emit. */
export type WgFlavour = 'amneziawg' | 'wireguard';

/** Client-visible extras that are not derived from the endpoint. */
export interface WgQuickOpts {
  /** Resolvers for the `DNS =` line. Empty / omitted leaves the line out. */
  dns?: string[];
  /** Tunnel name, emitted as the leading `# Name = ...` comment. */
  name?: string;
  /**
   * Which of the buyer's devices to emit, by device id or by 1-based position.
   *
   * Position is what the buyer's links carry, because "Device 2" has to mean
   * something in a URL; the id is accepted too and is the stable one, since a
   * revocation renumbers the positions after it.
   */
  device?: string;
}

/**
 * The one string that names a wg tunnel: the `.conf` file name (minus the
 * suffix) AND the `# Name =` comment inside it.
 *
 * One function because the two MUST agree. A client picks whichever it
 * understands — WG Tunnel reads the comment when importing from a URL and the
 * file name when importing a file — and a buyer who imports both ways would
 * otherwise end up with two differently-named tunnels to the same server.
 *
 * Sanitised to the file-name charset for the same reason: whatever this
 * returns has to survive being a file name on Windows and macOS.
 */
export function wgConfName(
  brand: string,
  nodeName?: string,
  flavour?: WgFlavour,
  deviceIndex?: number,
): string {
  // Серия недопустимых символов схлопывается в ОДИН разделитель: имя ноды несёт
  // эмодзи флага, и посимвольная замена давала `_____s2`.
  const clean = (s: string): string =>
    s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const parts = [clean(brand) || 'subscription'];
  if (nodeName) {
    const node = clean(nodeName);
    if (node) parts.push(node);
  }
  if (flavour) parts.push(flavour === 'wireguard' ? 'wg' : 'awg');
  // Device 1 goes unmarked: the buyer with a single device should not have to
  // wonder what the trailing number means, and the great majority have one.
  if (deviceIndex && deviceIndex > 1) parts.push(String(deviceIndex));
  return parts.join('-').slice(0, 64);
}

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
 * `opts.dns` writes the `DNS =` line. It is a panel-wide setting rather than a
 * per-profile field because it describes the CLIENT's resolver, not the
 * inbound: the node never sees this line. Omitting it is not neutral — with
 * `AllowedIPs = 0.0.0.0/0` the client keeps whatever resolver its network
 * handed it, and a LAN address like 192.168.1.1 then routes into the tunnel
 * and dies. Handshake up, ping by IP fine, nothing resolves.
 *
 * `opts.name` writes the leading `# Name =` comment — see wgConfName.
 *
 * Returns an empty string when nothing matches. Kept for the callers that only
 * want the text (the HTML page and the shop's install screen walk the endpoints
 * themselves, so a miss there is already impossible). The ROUTE must not use
 * this to decide the response — see selectWgEndpoint for why an empty body is
 * the one answer that cannot be told apart from a broken config.
 */
export function buildWgQuickConf(
  endpoints: SubscriptionEndpoint[],
  nodeName?: string,
  flavour?: WgFlavour,
  opts?: WgQuickOpts,
): string {
  const picked = selectWgEndpoint(endpoints, {
    node: nodeName,
    proto: flavour,
    device: opts?.device,
  });
  if (!picked.ok) return '';
  return renderWgQuickConf(picked.endpoint, opts);
}

/** One tunnel the subscription actually holds, in the terms the query names it
 *  by. This is what a miss gets told about, so it carries the node name
 *  VERBATIM — that name normally leads with a flag emoji, and `?node=s2`
 *  against `🇳🇱 s2` is the ordinary way to miss with a right-looking value. */
export interface WgTunnelRef {
  node: string;
  proto: WgFlavour;
  device: number;
}

/**
 * Which tunnel `?node=`/`?proto=`/`?device=` name, or why none.
 *
 * Three outcomes, because they are three different answers and the caller owes
 * the client a different one for each:
 *
 *   `no-wg-endpoint` — this subscription carries no wg-family channel at all.
 *     Nothing to give. Nothing the caller can rephrase to get one.
 *   `no-match` — it carries some, and the selectors named none of them. The
 *     request asked for something that does not exist, and `available` says
 *     what does.
 *   ok — the tunnel.
 *
 * All three used to be `''`, which the route sent as a 200 with a
 * `Content-Disposition` and a zero-byte body. Every wg client imports that and
 * reports the same thing: the config has no `PrivateKey`. So the symptom names
 * the config while the cause is in the selectors, and the buyer tells support
 * "the config is invalid" for a link that was merely addressed wrong.
 */
export type WgSelection =
  | { ok: true; endpoint: WgEndpoint }
  | { ok: false; reason: 'no-wg-endpoint'; available: [] }
  | { ok: false; reason: 'no-match'; available: WgTunnelRef[] };

export function selectWgEndpoint(
  endpoints: SubscriptionEndpoint[],
  want: { node?: string; proto?: WgFlavour; device?: string },
): WgSelection {
  const wgAll = endpoints.filter(isWgEndpoint);
  if (wgAll.length === 0) return { ok: false, reason: 'no-wg-endpoint', available: [] };

  let candidates = wgAll;
  if (want.proto) {
    candidates = candidates.filter((e) => e.protocol === want.proto);
  }
  if (want.device) {
    const wanted = want.device;
    const byIndex = Number(wanted);
    candidates = candidates.filter(
      (e) => e.deviceId === wanted || (Number.isInteger(byIndex) && e.deviceIndex === byIndex),
    );
  }
  // node selects which node's tunnel; absent = first (legacy whole-sub link).
  const wg = want.node ? candidates.find((e) => e.nodeName === want.node) : candidates[0];
  if (!wg) {
    return { ok: false, reason: 'no-match', available: listWgTunnels(wgAll) };
  }
  return { ok: true, endpoint: wg };
}

/** Every (node, flavour, device) this subscription can hand over, deduped and
 *  in subscription order. */
export function listWgTunnels(endpoints: SubscriptionEndpoint[]): WgTunnelRef[] {
  const seen = new Set<string>();
  const out: WgTunnelRef[] = [];
  for (const e of endpoints) {
    if (!isWgEndpoint(e)) continue;
    const ref = { node: e.nodeName, proto: e.protocol, device: e.deviceIndex };
    const key = `${ref.node}\u0000${ref.proto}\u0000${ref.device}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** One line per tunnel, in the exact form the query takes them: the operator or
 *  the buyer reading this has to be able to paste it back. */
export function describeWgTunnels(available: WgTunnelRef[]): string {
  return available
    .map((t) => `node=${JSON.stringify(t.node)} proto=${t.proto} device=${t.device}`)
    .join('; ');
}

function renderWgQuickConf(wg: WgEndpoint, opts?: WgQuickOpts): string {

  if (wg.protocol === 'wireguard') {
    return buildWireguardClientConfig({
      privateKey: wg.privateKey,
      allowedIp: wg.allowedIp,
      serverPublicKey: wg.serverPublicKey,
      host: wg.host,
      port: wg.port,
      dns: opts?.dns,
      name: opts?.name,
      presharedKey: wg.presharedKey,
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
    dns: opts?.dns,
    name: opts?.name,
    presharedKey: wg.presharedKey,
  });
}
