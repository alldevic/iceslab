import { buildAmneziawgClientConfig } from '../../../core-adapters/amneziawg/index.js';
import { buildWireguardClientConfig } from '../../../core-adapters/wireguard/index.js';
import { createHash } from 'node:crypto';
import type {
  SubscriptionEndpoint,
  AmneziawgSubscriptionEndpoint,
  WireguardSubscriptionEndpoint,
} from '../subscription.formats.js';
import { ofDevice, pickServer } from '../endpoint-identity.js';

export type WgconfEndpoint = AmneziawgSubscriptionEndpoint | WireguardSubscriptionEndpoint;

/** What the panel settings add to a wg-quick answer, beyond the endpoint. */
export interface WgClientOpts {
  /** Resolvers for the `DNS =` line (and `dns1`/`dns2` of the vpn:// key).
   *  Empty or absent: no line, the output the base always gave. */
  dns?: readonly string[];
  /** The operator's switch that takes `::/0` out of `AllowedIPs`. */
  dropIpv6?: boolean;
  /** Brand the tunnel name is built from; absent writes no `# Name =` line. */
  brand?: string;
}

/**
 * The `AllowedIPs` a wg-quick answer for this tunnel carries: `undefined` is
 * the builders' own default (`0.0.0.0/0, ::/0`), so a panel that never touched
 * the switch gets the bytes it always got.
 *
 * THE one place that decides it, called by every builder of a wg config (AWG
 * and plain `.conf`, the vpn:// key, the page's codes). `tunnel` is here for
 * the day a tunnel carries an IPv6 address of its own (9.9/18.9): such a
 * tunnel must keep `::/0` whatever the switch says, and the rule belongs on
 * this line (18.7 reconciles it with the IPv6 policy). Today no tunnel has one.
 */
export function wgClientAllowedIps(
  opts: Pick<WgClientOpts, 'dropIpv6'> | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for 18.7/18.9 (a tunnel with its own IPv6 keeps ::/0)
  _tunnel?: WgconfEndpoint,
): string[] | undefined {
  return opts?.dropIpv6 ? ['0.0.0.0/0'] : undefined;
}

/** The `dns` the builders take: undefined for none, so no key is added. */
export function wgClientDns(opts: Pick<WgClientOpts, 'dns'> | undefined): string[] | undefined {
  return opts?.dns?.length ? [...opts.dns] : undefined;
}

/** Ceiling on a WireGuard interface name: IFNAMSIZ (16) minus the terminator.
 *  wg-quick and the clients take the file name as the tunnel (interface) name,
 *  so this is a hard limit on what we may serve, not a style preference. */
export const WG_NAME_MAX = 15;

/**
 * The longest form of a brand that fits `budget`, cut at a word boundary when
 * there is one (`OneginVPNPro` -> `OneginVPN`, then `Onegin`), so a buyer's
 * tunnels do not spell the brand three ways. Hard truncation is the last
 * resort: a single long word has no boundary, and a name over the ceiling is
 * worse than an ugly one.
 */
function fitBrand(brand: string, budget: number): string {
  if (brand.length <= budget) return brand;
  const boundaries: number[] = [];
  for (let i = 1; i < brand.length; i++) {
    const caseChange = /[a-z0-9]/.test(brand[i - 1]!) && /[A-Z]/.test(brand[i]!);
    if (caseChange || /[._-]/.test(brand[i]!)) boundaries.push(i);
  }
  for (const at of [...boundaries].reverse()) {
    const cut = brand.slice(0, at).replace(/[-_.]+$/, '');
    if (cut.length > 0 && cut.length <= budget) return cut;
  }
  return brand.slice(0, Math.max(budget, 0));
}

/**
 * The one string that names a wg tunnel: the `.conf` file name (minus the
 * suffix) AND the `# Name =` comment inside it. A client reads whichever it
 * understands (a file import the name, a URL import the comment), so the two
 * MUST agree, and both must be legal as a file name and as an interface name:
 * `[a-zA-Z0-9._-]`, at most 15 characters (WG_NAME_MAX).
 *
 * `<brand>-<node>-<awg|wg>[-<device>]`; device 1 goes unmarked. The brand is
 * what gets cut, because the rest tells a buyer's tunnels apart. A node name
 * too long to fit even alone is cut with three hex characters of its own digest
 * in place of its end, so two nodes sharing a long beginning still differ.
 */
export function wgConfName(
  brand: string,
  nodeName?: string,
  protocol?: 'amneziawg' | 'wireguard',
  deviceIndex?: number,
): string {
  // A run of unusable characters is ONE separator: a node name leads with a
  // flag emoji, and a per-character replacement gave `_____s2`.
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[-_.]+|[-_.]+$/g, '');
  const tail: string[] = [];
  if (protocol) tail.push(protocol === 'wireguard' ? 'wg' : 'awg');
  if (deviceIndex && deviceIndex > 1) tail.push(String(deviceIndex));
  const tailStr = tail.length > 0 ? `-${tail.join('-')}` : '';
  // The room the brand and node are cut to is computed as if the device number
  // were always there (one digit; device 10 takes one more), so one buyer's devices
  // get the SAME spelling of both and differ only by the number: three files
  // spelling the brand three ways read as three different products.
  const reserved = tailStr.length + (deviceIndex && deviceIndex > 1 ? 0 : 2);
  let node = nodeName ? clean(nodeName) : '';
  // A node name too long for the rest is cut so that a few characters of the
  // brand still show: a name without it is not the brand's name any more.
  const brandClean = clean(brand) || 'subscription';
  const brandMin = Math.min(brandClean.length, 3) + 1;
  const nodeRoom = WG_NAME_MAX - reserved - 1 - brandMin;
  if (node.length > nodeRoom) {
    const digest = createHash('sha256').update(node).digest('hex').slice(0, 3);
    node = `${node.slice(0, Math.max(nodeRoom - 3, 0)).replace(/[-_.]+$/, '')}${digest}`;
  }
  const nodePart = node ? `-${node}` : '';
  const brandRoom = WG_NAME_MAX - nodePart.length - reserved;
  const head = fitBrand(brandClean, brandRoom);
  // A cut can leave a separator hanging, and wg-quick takes the name verbatim.
  const name = `${head}${nodePart}${tailStr}`.replace(/^[-_.]+/, '').replace(/[-_.]+$/, '');
  return (name || 'subscription').slice(0, WG_NAME_MAX);
}

/** The tunnel name of the endpoint a wgconf answer is built from. */
export function wgconfTunnelName(
  endpoints: SubscriptionEndpoint[],
  brand: string,
  node?: string,
  device?: string,
): string {
  const picked = pickWgconfEndpoint(endpoints, node, device);
  return wgConfName(brand, picked?.nodeName, picked?.protocol, picked?.deviceIndex);
}

/** The tunnel a wgconf answer is built from, or undefined when there is none. */
export function pickWgconfEndpoint(
  endpoints: SubscriptionEndpoint[],
  node?: string,
  device?: string,
): WgconfEndpoint | undefined {
  // `device` selects whose key (absent = device 1), then `node` which tunnel.
  const awg = ofDevice(
    endpoints.filter((e): e is AmneziawgSubscriptionEndpoint => e.protocol === 'amneziawg'),
    device,
  );
  const wg = ofDevice(
    endpoints.filter((e): e is WireguardSubscriptionEndpoint => e.protocol === 'wireguard'),
    device,
  );
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
  device?: string,
  opts?: WgClientOpts,
): string {
  const picked = pickWgconfEndpoint(endpoints, node, device);
  if (!picked) return '';
  const dns = wgClientDns(opts);
  const clientAllowedIps = wgClientAllowedIps(opts, picked);
  const shared = {
    ...(dns ? { dns } : {}),
    ...(clientAllowedIps ? { clientAllowedIps } : {}),
  };
  const nameLine =
    opts?.brand === undefined
      ? ''
      : `# Name = ${wgConfName(opts.brand, picked.nodeName, picked.protocol, picked.deviceIndex)}\n`;
  return nameLine + buildPicked(picked, shared);
}

function buildPicked(
  picked: WgconfEndpoint,
  shared: { dns?: string[]; clientAllowedIps?: string[] },
): string {
  if (picked.protocol === 'wireguard') {
    return buildWireguardClientConfig({
      ...shared,
      privateKey: picked.privateKey,
      allowedIp: picked.allowedIp,
      serverPublicKey: picked.serverPublicKey,
      ...(picked.presharedKey ? { presharedKey: picked.presharedKey } : {}),
      host: picked.host,
      port: picked.port,
    });
  }
  const awg = picked;
  return buildAmneziawgClientConfig({
    ...shared,
    privateKey: awg.privateKey,
    allowedIp: awg.allowedIp,
    serverPublicKey: awg.serverPublicKey,
    ...(awg.presharedKey ? { presharedKey: awg.presharedKey } : {}),
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
