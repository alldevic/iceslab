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
import type { ClientFormat } from './format-usable.js';

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
  | { kind: 'endpoint-link' } // open this node's own link (mtproto: t.me/proxy)
  | { kind: 'manual' }; // paste the subscription link

/**
 * Where to GET the app, per platform. Optional and deliberately sparse.
 *
 * Every URL here was opened and checked before being written down, because a
 * store link is the one thing on an install page that can send a buyer to the
 * wrong software. Two rules follow from that and explain the gaps:
 *
 *  - **No version-pinned links.** The shop's own default guide ships direct
 *    GitHub release URLs (Clash Verge v2.x .deb, `v2rayNG_2.0.9.apk`). Copied
 *    here they would be a stale download the day upstream tags a release.
 *  - **No inherited links.** The shop's `sing-box` entry points at App Store id
 *    6673731168, which answers 404 — the app is gone, and the official sing-box
 *    Apple client is currently off the App Store entirely (SagerNet's clients
 *    are in review limbo). So sing-box gets no link rather than a dead one.
 *
 * An app with nothing here is named but not linked, which is the honest state:
 * the buyer knows what to install and finds it themselves.
 */
export type InstallLinks = Partial<Record<PlatformId, string>>;

export interface AppDef {
  name: string;
  platforms: PlatformId[];
  protocols: ProtocolName[];
  action: AppAction;
  recommended?: boolean;
  /** Verified download destinations, per platform. See InstallLinks. */
  install?: InstallLinks;
  /**
   * The core this client speaks, and so the format it fetches from `/sub`.
   *
   * Declared so the catalogue can drop an app whose format renders NOTHING for
   * this buyer. On an XHTTP-only fleet sing-box emits no server at all, so
   * every sing-box-cored client hands back an empty config while looking like
   * it worked — the same "working client aimed at nothing" the delivery rule
   * above exists to prevent, one level down.
   *
   * It mirrors the seeded User-Agent rule for that client, and in that
   * direction: the rule points Hiddify at `singbox` BECAUSE Hiddify runs
   * sing-box. Omitted for clients that fetch no subscription format at all
   * (the tunnel apps, Telegram) and for ones whose choice is not ours to state.
   */
  format?: ClientFormat;
}

// TUIC, AnyTLS and ShadowTLS were added to the clients below on 2026-09-03,
// and by measurement rather than by reading vendor pages: the live subscription
// was fetched once per client User-Agent and the result read back. sing-box
// clients get all three, mihomo clients get all three as well (ShadowTLS
// arrives as `type: ss` with `plugin: shadow-tls`), and the link-list clients
// get TUIC and AnyTLS but NOT ShadowTLS — it has no share link at all, so it
// exists only inside a whole config. Happ and INCY were left alone: Happ's own
// rule hands it an xray document that carries neither, and INCY was not probed.
//
// This list is what decides whether an app is offered at all, so under-declaring
// it hides a capable client from a buyer who holds only the new channels.
export const APPS: AppDef[] = [
  // Universal subscription clients (xray / shadowsocks / hysteria via the link).
  {
    name: 'Hiddify',
    format: 'singbox',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv'],
    protocols: ['amneziawg', 'xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls', 'shadowtls'],
    action: { kind: 'deeplink', scheme: 'hiddify' },
    recommended: true,
    // From hiddify.com, the project's own page (checked 2026-08-26). Desktop
    // builds live on GitHub releases, so the project page is the destination
    // rather than a versioned asset.
    install: {
      ios: 'https://apps.apple.com/app/id6596777532',
      android: 'https://play.google.com/store/apps/details?id=app.hiddify.com',
      windows: 'https://hiddify.com/',
      macos: 'https://hiddify.com/',
      linux: 'https://hiddify.com/',
    },
  },
  {
    name: 'sing-box',
    format: 'singbox',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls', 'shadowtls'],
    action: { kind: 'deeplink', scheme: 'singbox' },
    // From sing-box.sagernet.org/clients/* (checked 2026-08-26).
    //
    // No iOS entry, and that is the finding rather than an omission: the
    // project's own page still links App Store id 6673731168, and that listing
    // answers 404. Its own words — "We are temporarily unable to update
    // sing-box apps on the App Store because the reviewer mistakenly found that
    // we violated the rules" — with TestFlight restricted to sponsors. There is
    // nowhere to send an iPhone buyer, so we send them nowhere rather than to a
    // dead page.
    install: {
      android: 'https://play.google.com/store/apps/details?id=io.nekohasekai.sfa',
      macos: 'https://github.com/SagerNet/sing-box/releases',
      windows: 'https://github.com/SagerNet/sing-box/releases',
      linux: 'https://github.com/SagerNet/sing-box/releases',
    },
  },
  {
    name: 'Streisand',
    format: 'plain',
    platforms: ['ios', 'macos', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls'],
    action: { kind: 'deeplink', scheme: 'streisand' },
    recommended: true,
    // Checked 2026-08-26: "Streisand" by ARCADIA ODYSSEY INC.
    install: { ios: 'https://apps.apple.com/app/id6450534064' },
  },
  {
    name: 'Shadowrocket',
    format: 'plain',
    platforms: ['ios', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls'],
    action: { kind: 'deeplink', scheme: 'shadowrocket' },
    // Checked 2026-08-26: "Shadowrocket" by Shadow Launch Technology Limited.
    install: {
      ios: 'https://apps.apple.com/app/id932747118',
      appletv: 'https://apps.apple.com/app/id932747118',
    },
  },
  {
    name: 'v2rayNG',
    format: 'xrayjson',
    platforms: ['android', 'androidtv'],
    protocols: ['xray', 'shadowsocks'],
    action: { kind: 'deeplink', scheme: 'v2rayng' },
    recommended: true,
    // 2dust/v2rayNG, the upstream repository (checked 2026-08-26). `/latest`
    // rather than a tag: the shop's own guide pins `v2rayNG_2.0.9.apk`, which
    // is two majors behind by now.
    install: {
      android: 'https://github.com/2dust/v2rayNG/releases/latest',
      androidtv: 'https://github.com/2dust/v2rayNG/releases/latest',
    },
  },
  {
    name: 'NekoBox',
    format: 'singbox',
    platforms: ['android'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls', 'shadowtls'],
    action: { kind: 'manual' },
    // MatsuriDayo/NekoBoxForAndroid (checked 2026-08-26). Alive but quiet —
    // upstream calls its own maintenance "relatively minimal" and the last
    // release is from early 2024. Listed after the actively developed clients
    // on the same tab, never as the recommended one.
    install: { android: 'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases/latest' },
  },
  {
    name: 'v2rayN',
    format: 'xrayjson',
    platforms: ['windows'],
    protocols: ['xray', 'shadowsocks'],
    action: { kind: 'manual' },
    // 2dust/v2rayN (checked 2026-08-26).
    install: { windows: 'https://github.com/2dust/v2rayN/releases/latest' },
  },
  // Nekoray was here and is gone (2026-08-26): MatsuriDayo/nekoray was ARCHIVED
  // by its owner on 2025-03-17 and is read-only, its own release notes call it
  // "a Windows/Linux endpoint node debugging tool", discourage ordinary users
  // and point them at Clash Verge Rev — which this catalogue already offers on
  // both of Nekoray's platforms, with the same protocols. Nothing was lost by
  // dropping it, and offering an abandoned tool its authors steer people away
  // from is the opposite of what this table is for.
  // The mihomo-cored clients, and the only ones listed for `mieru`: our clash
  // builder emits it as `type: mieru`, and the seeded UA rule points this
  // family at the clash format, so the chain from their deep link to a working
  // entry is ours end to end. The other formats that carry mieru (surge, loon,
  // quantumultx) have no client in this catalogue at all.
  {
    name: 'Clash Verge',
    format: 'clash',
    platforms: ['windows', 'macos', 'linux'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'mieru', 'tuic', 'anytls', 'shadowtls'],
    action: { kind: 'deeplink', scheme: 'clash' },
    // clash-verge-rev/clash-verge-rev (checked 2026-08-26). `/latest` rather
    // than the pinned .deb/.rpm/.exe URLs the shop's guide carries.
    install: {
      windows: 'https://github.com/clash-verge-rev/clash-verge-rev/releases/latest',
      macos: 'https://github.com/clash-verge-rev/clash-verge-rev/releases/latest',
      linux: 'https://github.com/clash-verge-rev/clash-verge-rev/releases/latest',
    },
  },
  {
    name: 'FlClash',
    format: 'clash',
    platforms: ['android', 'windows', 'macos', 'linux'],
    protocols: ['xray', 'shadowsocks', 'hysteria', 'mieru', 'tuic', 'anytls', 'shadowtls'],
    action: { kind: 'deeplink', scheme: 'clash' },
    // chen08209/FlClash (checked 2026-08-26); one release covers all four.
    install: {
      android: 'https://github.com/chen08209/FlClash/releases/latest',
      windows: 'https://github.com/chen08209/FlClash/releases/latest',
      macos: 'https://github.com/chen08209/FlClash/releases/latest',
      linux: 'https://github.com/chen08209/FlClash/releases/latest',
    },
  },
  {
    // Happ (happ.info, formerly happ.su). xray-cored, with a native hysteria2
    // core, and by a distance the most common client our own buyers arrive
    // with — `Happ/4.3.0/Android` leads `subscription_request_history`. It was
    // absent here while the shop's install screen came from us, so the one app
    // most of them already run was the one we did not name.
    //
    // `manual`, not a deep link, on the same rule as INCY above: Happ's docs
    // publish `happ://routing/add/{base64}` and `happ://crypto...`, but no
    // documented scheme for adding a subscription BY URL. A guessed deep link
    // on an install screen is the failure this file's header refuses, so the
    // buyer pastes the link until the scheme is confirmed on a device.
    //
    // Happ fetches `xrayjson-array` — the format that exists for it, seeded onto
    // its User-Agent rule on 2026-09-01 so the routing preset would reach it at
    // all. `ClientFormat` has no array member because `usableFormats` asks by
    // rendering, and the array is the same xray document split per profile.
    //
    // Declaring `plain` here outlived that change by two days and was not
    // harmless: the install card reads this field to say where the routing
    // rules live, so Happ buyers were told their traffic carries no rules while
    // their config carried five (measured 2026-09-03 on `Happ/4.3.0/Android`:
    // three profiles, three geo rules each).
    //
    // The trade it makes is real and unrecorded here on purpose — see
    // `14-defects.md` in the deployment repo: an xray document cannot carry
    // TUIC, AnyTLS, ShadowTLS or the MTProto link, so this buyer sees two
    // channels where a sing-box client sees five.
    name: 'Happ',
    format: 'xrayjson',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv', 'appletv'],
    protocols: ['xray', 'shadowsocks', 'hysteria'],
    action: { kind: 'manual' },
    // From happ.info, the project's own page (checked 2026-09-01, every URL
    // opened). One App Store listing serves iOS and macOS; the TV build is a
    // separate listing. Desktop and the Android APK live on GitHub, so the
    // `releases/latest` page is the destination rather than a tagged asset.
    install: {
      ios: 'https://apps.apple.com/app/id6504287215',
      macos: 'https://apps.apple.com/app/id6504287215',
      android: 'https://play.google.com/store/apps/details?id=com.happproxy',
      androidtv: 'https://play.google.com/store/apps/details?id=com.happproxy',
      appletv: 'https://apps.apple.com/app/id6748297274',
      windows: 'https://github.com/Happ-proxy/happ-desktop/releases/latest',
      linux: 'https://github.com/Happ-proxy/happ-desktop/releases/latest',
    },
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
    // From incy-app.com, the project's own page (checked 2026-08-26); the store
    // listing is "incy" by LLC ITDEV. The desktop and TV builds live in the
    // GitHub organisation the site points at, so that repository is the
    // destination rather than a versioned artefact.
    install: {
      ios: 'https://apps.apple.com/app/id6756943388',
      android: 'https://play.google.com/store/apps/details?id=llc.itdev.incy',
      macos: 'https://github.com/INCY-DEV/incy-platforms',
      windows: 'https://github.com/INCY-DEV/incy-platforms',
      linux: 'https://github.com/INCY-DEV/incy-platforms',
    },
  },
  // AmneziaWG-specific.
  {
    name: 'AmneziaVPN',
    platforms: ['ios', 'macos', 'windows', 'linux', 'android', 'androidtv'],
    protocols: ['amneziawg'],
    action: { kind: 'awg-vpn' },
    recommended: true,
    // From amnezia.org/en/downloads, the project's own page (checked
    // 2026-08-26); the store listing is "AmneziaVPN" by Privacy Technologies.
    // Desktop builds are direct files off that page, so the page itself is the
    // stable destination rather than a versioned artefact.
    install: {
      ios: 'https://apps.apple.com/app/id1600529900',
      android: 'https://play.google.com/store/apps/details?id=org.amnezia.vpn',
      windows: 'https://amnezia.org/en/downloads',
      macos: 'https://amnezia.org/en/downloads',
      linux: 'https://amnezia.org/en/downloads',
    },
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
    // amnezia-vpn/amneziawg-tools, upstream for `awg(8)` and `awg-quick(8)`
    // (checked 2026-08-26, not archived). Only the Linux tab gets it: `router`
    // is not a platform the shop's document can express at all, and a router
    // owner is not "installing an app".
    install: { linux: 'https://github.com/amnezia-vpn/amneziawg-tools' },
  },
  // Keenetic and OpenWrt stay UNLINKED on purpose, and it is not an omission:
  // they are router firmware, not an app anyone downloads to connect. The buyer
  // already owns the router; what they need is its own documentation for
  // importing a tunnel, which differs by model and firmware version and is not
  // a "get the app" link. Both are also `router`-only, a platform the shop's
  // document cannot express, so only our own page lists them at all.
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
    // wireguard.com/install is the project's own list (checked 2026-08-26); the
    // iOS listing is "WireGuard" by WireGuard Development Team / WireGuard LLC.
    install: {
      ios: 'https://apps.apple.com/app/id1441195209',
      android: 'https://play.google.com/store/apps/details?id=com.wireguard.android',
    },
  },
  {
    name: 'WireGuard',
    platforms: ['windows', 'macos', 'linux'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
    recommended: true,
    // Same source. Linux is per-distro package commands there, so the page is
    // the destination; macOS is its own App Store listing.
    install: {
      windows: 'https://www.wireguard.com/install/',
      macos: 'https://apps.apple.com/app/id1451685025',
      linux: 'https://www.wireguard.com/install/',
    },
  },
  {
    name: 'WireSock',
    platforms: ['windows'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
    // wiresock.net, the vendor's own download page (checked 2026-08-26):
    // "WireSock Secure Connect", free for personal, educational and non-profit
    // use, with a PRO licence for commercial. The page, not one of its three
    // architecture-specific installers — the buyer picks their own.
    install: { windows: 'https://www.wiresock.net/wiresock-secure-connect/download' },
  },
  {
    name: 'wg-quick',
    platforms: ['linux', 'router'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
    // wireguard.com/install lists the per-distribution package commands; there
    // is no single file to fetch, so the page is the destination.
    install: { linux: 'https://www.wireguard.com/install/' },
  },
  {
    name: 'Keenetic',
    platforms: ['router'],
    protocols: ['wireguard'],
    action: { kind: 'download' },
  },
  // MTProto. The client is Telegram itself — there is no third-party app to
  // install and nothing to import: the `t.me/proxy` link IS the whole setup,
  // and Telegram turns it into a "connect to this proxy" prompt. One link per
  // node, because Telegram holds one proxy at a time.
  {
    name: 'Telegram',
    platforms: ['ios', 'android', 'windows', 'macos', 'linux'],
    protocols: ['mtproto'],
    action: { kind: 'endpoint-link' },
    recommended: true,
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
  // Delivered in the subscription, but ONLY by `plain`: clash refuses it on
  // purpose ("Clash Meta's experimental naive support diverges per fork") and
  // sing-box has no naive outbound at all. So the catalogue names no client for
  // it — the ones that speak naive (the naiveproxy CLI, the Neko family) either
  // are not an app a guide can send someone to, or resolve to a format that
  // drops the endpoint. Naming one anyway would be the promise this table
  // exists to avoid.
  naive: 'subscription',
  mieru: 'subscription',
  tuic: 'subscription',
  anytls: 'subscription',
  // No standardised URI form for either flavour; clients fetch ?format=wgconf
  // (and AmneziaVPN additionally takes the ?format=amneziavpn key).
  amneziawg: 'per-node-file',
  wireguard: 'per-node-file',
  // Telegram is the client, and it imports one t.me/proxy link per node.
  mtproto: 'per-endpoint-link',
  // In the product since 2026-09-02, and the note that used to sit here is
  // stale: `POST /api/profiles` accepts shadowtls now (the discriminator lists
  // eleven protocols; the old comment measured eight on 2026-08-25). Verified by
  // creating one.
  //
  // What IS still true, and matters more, is that ShadowTLS has no share link at
  // all - subscription.service.ts emits `uri: ''` for it, because no standard URI
  // form exists. So it reaches only the clients that read a FULL config from us:
  // sing-box and clash. A buyer on `plain` (Shadowrocket, Streisand, V2Box) or on
  // Happ does not see this channel, and no error says so - the line is simply
  // absent. Worth knowing before a tariff promises it by name.
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
    // One link per node, handed over as-is.
    case 'endpoint-link':
      return 'per-endpoint-link';
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
  /** Formats that render at least one server for this buyer (see
   *  `usableFormats`). Omit to skip the check — callers that have no endpoints
   *  to hand, such as a catalogue listing, should not start guessing. */
  usableFormats?: ReadonlySet<ClientFormat>,
): AppDef[] {
  const present = new Set(protocols);
  return APPS.filter((a) => {
    if (!a.platforms.includes(platform)) return false;
    const needed = deliveryNeededBy(a.action);
    if (!a.protocols.some((p) => present.has(p) && PROTOCOL_DELIVERY[p] === needed)) return false;
    // Speaking the protocol and being reachable by its channel is still not
    // enough: the format this client fetches has to render something.
    if (usableFormats && a.format && !usableFormats.has(a.format)) return false;
    return true;
  });
}
