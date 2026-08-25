// The client catalogue: which app a buyer should use, for which protocol, on
// which device.
//
// It lives on its own because there are TWO surfaces that answer that question
// and they must answer it identically. `page.ts` renders it as our own HTML
// landing page; `remnawave-compat/subpage` renders it as the Subscription Page
// v1 document the shop's MiniApp draws its install screen from. Before this
// split the catalogue was private to `page.ts` and the shop had no access to it
// at all, so a buyer reading the shop's screen was shown a generic list that
// knew nothing about what they had actually bought.
//
// Curated and protocol-accurate. An app belongs on a platform tab only when
// that platform is in its `platforms` AND it speaks at least one of the
// subscription's protocols. AmneziaWG obfuscation (Jc/S/H/I) needs an AWG-aware
// client, so the xray/ss subscription clients are NOT listed for amneziawg, and
// vice versa.

import type { ProtocolName } from '@iceslab/shared';

export type PlatformId =
  | 'ios'
  | 'android'
  | 'windows'
  | 'macos'
  | 'linux'
  | 'androidtv'
  | 'appletv'
  | 'router';


export const PLATFORM_ORDER: PlatformId[] = [
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'androidtv',
  'appletv',
  'router',
];

// Display labels. Most are proper nouns (same in both languages); only Router
// differs, handled in L below via routerLabel.
export const PLATFORM_LABEL: Record<PlatformId, string> = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  androidtv: 'Android TV',
  appletv: 'Apple TV',
  router: '',
};

export type AppAction =
  | { kind: 'deeplink'; scheme: 'hiddify' | 'streisand' | 'v2rayng' | 'clash' | 'singbox' | 'shadowrocket' }
  | { kind: 'awg-vpn' } // scan the AmneziaVPN vpn:// QR below
  | { kind: 'awg-conf' } // scan the AmneziaWG .conf QR below
  | { kind: 'wg-conf' } // scan the plain WireGuard .conf QR below
  | { kind: 'download' } // grab the per-node .conf below
  | { kind: 'manual' }; // paste the subscription link

export interface AppDef {
  name: string;
  platforms: PlatformId[];
  protocols: ProtocolName[];
  action: AppAction;
  recommended?: boolean;
}

export const APPS: AppDef[] = [
  // Universal subscription clients (xray / shadowsocks / hysteria via the link).
  {
    name: 'Hiddify',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv'],
    protocols: ['amneziawg', 'xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'hiddify' },
    recommended: true,
  },
  {
    name: 'sing-box',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'singbox' },
  },
  {
    name: 'Streisand',
    platforms: ['ios', 'macos', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'streisand' },
    recommended: true,
  },
  {
    name: 'Shadowrocket',
    platforms: ['ios', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'shadowrocket' },
  },
  {
    name: 'v2rayNG',
    platforms: ['android', 'androidtv'],
    protocols: ['xray', 'shadowsocks'],
    action: { kind: 'deeplink', scheme: 'v2rayng' },
    recommended: true,
  },
  {
    name: 'NekoBox',
    platforms: ['android'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'manual' },
  },
  {
    name: 'v2rayN',
    platforms: ['windows'],
    protocols: ['xray', 'shadowsocks'],
    action: { kind: 'manual' },
  },
  {
    name: 'Nekoray',
    platforms: ['windows', 'linux'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'manual' },
  },
  {
    name: 'Clash Verge',
    platforms: ['windows', 'macos', 'linux'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'clash' },
  },
  {
    name: 'FlClash',
    platforms: ['android', 'windows', 'macos', 'linux'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'deeplink', scheme: 'clash' },
  },
  {
    // INCY (incy-app.com). Cross-platform client; imports our subscription via
    // its "add server from URL / QR". One-tap import needs its incy://crypt1
    // deep link (AES-GCM payload from @incy/link-encoder); wire that up once the
    // package is installed (see deeplinkHref). Until then: import via the link.
    name: 'INCY',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'manual' },
  },
  // AmneziaWG-specific.
  {
    name: 'AmneziaVPN',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv'],
    protocols: ['amneziawg'],
    action: { kind: 'awg-vpn' },
    recommended: true,
  },
  {
    name: 'AmneziaWG',
    platforms: ['ios', 'android'],
    protocols: ['amneziawg'],
    action: { kind: 'awg-conf' },
  },
  {
    name: 'wg-quick / awg',
    platforms: ['linux', 'router'],
    protocols: ['amneziawg'],
    action: { kind: 'download' },
  },
  {
    name: 'Keenetic',
    platforms: ['router'],
    protocols: ['amneziawg'],
    action: { kind: 'download' },
  },
  {
    name: 'OpenWrt',
    platforms: ['router'],
    protocols: ['amneziawg', 'xray'],
    action: { kind: 'manual' },
  },
  // Plain WireGuard. Deliberately a separate list from AmneziaWG: an AWG
  // config's Jc/S/H directives make these clients refuse the file outright,
  // and an AWG-aware client is exactly what this protocol exists to avoid
  // needing.
  {
    name: 'WireGuard',
    platforms: ['ios', 'android'],
    protocols: ['wireguard'],
    action: { kind: 'wg-conf' },
    recommended: true,
  },
  {
    name: 'WireGuard',
    platforms: ['windows', 'macos', 'linux'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
    recommended: true,
  },
  {
    name: 'WireSock',
    platforms: ['windows'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
  },
  {
    name: 'wg-quick',
    platforms: ['linux', 'router'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
  },
  {
    name: 'Keenetic',
    platforms: ['router'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
  },
];

export function deeplinkHref(
  scheme: Extract<AppAction, { kind: 'deeplink' }>['scheme'],
  subUrl: string,
): string {
  const enc = encodeURIComponent(subUrl);
  switch (scheme) {
    case 'hiddify':
      return `hiddify://import/${subUrl}`;
    case 'streisand':
      return `streisand://import/${subUrl}`;
    case 'v2rayng':
      return `v2rayng://install-sub?url=${enc}`;
    case 'clash':
      return `clash://install-config?url=${enc}`;
    case 'singbox':
      return `sing-box://import-remote-profile?url=${enc}`;
    case 'shadowrocket':
      return `sub://${Buffer.from(subUrl, 'utf8').toString('base64')}`;
  }
}

// ───── How a config reaches the buyer ─────

/**
 * The delivery channel for a protocol: not "which app", but "what does the
 * buyer's app have to be handed".
 *
 * This exists because the answer is NOT uniform and the difference is invisible
 * until someone buys the wrong protocol. A `vless://` line rides inside the
 * subscription, so the app only ever needs the subscription URL. An AmneziaWG
 * tunnel has no share-link at all (`subscription.service.ts` emits `uri: ''`),
 * so the buyer needs a file, one per node. MTProto has a link but no
 * subscription-reading client — Telegram takes the single `t.me/proxy` URL and
 * nothing else.
 *
 * Measured 2026-08-25 on the lab: a user whose only squad profile is AmneziaWG
 * gets 0 bytes from `?format=plain`, an empty `proxies: []` from `?format=clash`
 * and a lone `direct` outbound from `?format=singbox` — while `wgconf` and
 * `amneziavpn` serve them correctly. That is this table, observed.
 *
 * The Record is exhaustive over ProtocolName ON PURPOSE: adding a protocol to
 * the union fails the build here until someone states how its buyers are
 * supposed to connect. That question has been answered late twice already.
 */
export type Delivery =
  /** The share-link is in the subscription; hand the app the subscription URL. */
  | 'subscription'
  /** No share-link exists; the panel renders one config FILE per node. */
  | 'per-node-file'
  /** A link exists, but no client reads our subscription for it — hand over the
   *  single per-endpoint link instead. */
  | 'per-endpoint-link';

export const PROTOCOL_DELIVERY: Record<ProtocolName, Delivery> = {
  hysteria: 'subscription',
  xray: 'subscription',
  shadowsocks: 'subscription',
  naive: 'subscription',
  mieru: 'subscription',
  tuic: 'subscription',
  anytls: 'subscription',
  // No standardised URI form for either flavour; clients fetch ?format=wgconf
  // (and AmneziaVPN additionally takes the ?format=amneziavpn key).
  amneziawg: 'per-node-file',
  wireguard: 'per-node-file',
  // Telegram is the client, and it imports one tg://proxy | t.me/proxy link.
  mtproto: 'per-endpoint-link',
  // Reachable in the subscription builder but not in the product: a squad holds
  // PROFILES, and `POST /api/profiles` rejects shadowtls (the discriminator
  // lists eight protocols; measured 2026-08-25, HTTP 400). Nobody can buy it,
  // so nobody is stranded by it — but the branch in subscription.service.ts is
  // dead until profiles learn the protocol. Same for tuic/anytls above.
  shadowtls: 'subscription',
};

/** What an app's import path needs to be handed for it to work at all. */
function deliveryNeededBy(action: AppAction): Delivery {
  switch (action.kind) {
    // Both hand the app the subscription URL and nothing else.
    case 'deeplink':
    case 'manual':
      return 'subscription';
    // Scan a QR of a .conf, scan the vpn:// key, download the .conf — all three
    // are the panel handing over one node's file.
    case 'awg-vpn':
    case 'awg-conf':
    case 'wg-conf':
    case 'download':
      return 'per-node-file';
  }
}

/**
 * The apps a buyer on `platform` can actually use, given the protocols their
 * subscription really contains. Shared by both install surfaces so neither can
 * promise a client the other one knows is wrong.
 *
 * Speaking the protocol is NOT enough — the app has to be reachable by the
 * channel that protocol is delivered over. Hiddify speaks AmneziaWG and imports
 * a wg-quick file, but the entry below offers it as a subscription deep link;
 * handing an AmneziaWG-only buyer `hiddify://import/<sub>` points a working
 * client at a subscription that is empty for them (measured: 0 bytes). So an
 * app whose action takes the subscription URL is listed only when the buyer
 * holds a protocol that actually rides in the subscription, and a file-based
 * app only when they hold one that produces files.
 *
 * The consequence to know about: an AmneziaWG-only buyer is not offered
 * Hiddify at all, though Hiddify could import their .conf. Teaching one app two
 * delivery paths is a catalogue change that needs checking against the client,
 * not a guess to make here.
 */
export function appsForPlatform(
  platform: PlatformId,
  protocols: readonly ProtocolName[],
): AppDef[] {
  const present = new Set(protocols);
  return APPS.filter((a) => {
    if (!a.platforms.includes(platform)) return false;
    const needed = deliveryNeededBy(a.action);
    return a.protocols.some((p) => present.has(p) && PROTOCOL_DELIVERY[p] === needed);
  });
}
