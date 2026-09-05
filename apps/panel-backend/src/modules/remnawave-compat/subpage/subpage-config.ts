// Subscription Page v1: the install screen the shop's MiniApp draws for ONE
// buyer, built from what that buyer actually holds.
//
// Why this exists at all. The shop asks the panel three questions, in order
// (`bot/app/web/webapp/guides_panel_config.py`), and the FIRST one is
// `GET /subscriptions/subpage-config/{shortUuid}` — a config for a specific
// subscription. At that moment the panel knows exactly which protocols that
// person has. Answering `{}` throws the question away: the shop logs a warning
// and renders its own bundled document, which knows nothing about this fleet
// and lists no WireGuard client at all. A buyer whose squad is AmneziaWG-only
// was therefore shown Happ, sing-box and v2rayNG — three clients that cannot
// read their config — plus a subscription link that serves them 0 bytes
// (measured 2026-08-25).
//
// What the shop does with what we return, read from its source rather than
// assumed:
//   - `InstallGuideScreen.svelte` renders `platforms`, `svgLibrary` and two
//     `baseTranslations` keys. Nothing else in the document reaches the buyer.
//   - Buttons are the only per-app mechanism: `installGuideRuntime.ts` copies a
//     `copyButton`'s link and opens every other type. There is no per-button QR.
//   - The one QR on the screen is always the subscription URL — which is the
//     useless artefact for exactly the buyers this file exists for. So their
//     apps are given a file link or a key to copy, never "scan the QR".
//   - `installPlatformsFromConfig` drops a platform with no apps, and the
//     validator REJECTS one (`_validate_apps`: "must be a non-empty array"),
//     which would fail the whole document. So a platform with nothing to offer
//     is omitted, never emitted empty.
//
// Deep links carry the real subscription URL rather than the shop's
// `{{SUBSCRIPTION_LINK}}` placeholder. Two reasons: `deeplinkHref` percent-
// encodes the URL for some schemes and the placeholder cannot survive that, and
// sharing one builder with `formats/page.ts` is the entire point — the two
// install surfaces must not drift into promising different things.

import type { ProtocolName } from '@iceslab/shared';
import {
  PLATFORM_ORDER,
  appsForPlatform,
  deeplinkHref,
  type AppDef,
  type PlatformId,
} from '../../subscription/formats/client-catalog.js';
import type { ClientFormat } from '../../subscription/formats/format-usable.js';
import { BASE_TRANSLATIONS, SUBPAGE_LOCALES, SVG_LIBRARY } from './chrome.js';

/** A string in every locale the document declares. The shop's
 *  `_validate_locale_strings` requires all of them on every localized field. */
type Localized = Record<string, string>;

interface SubpageButton {
  type: 'copyButton' | 'external' | 'subscriptionLink';
  link: string;
  text: Localized;
  svgIconKey: string;
}

interface SubpageBlock {
  svgIconKey: string;
  svgIconColor: string;
  title: Localized;
  description: Localized;
  buttons: SubpageButton[];
}

interface SubpageApp {
  name: string;
  svgIconKey?: string;
  featured: boolean;
  blocks: SubpageBlock[];
}

export interface SubpageConfig {
  version: '1';
  locales: string[];
  brandingSettings: { title: string; logoUrl: string; supportUrl: string };
  uiConfig: { subscriptionInfoBlockType: string; installationGuidesBlockType: string };
  baseSettings: Record<string, unknown>;
  baseTranslations: Record<string, Localized>;
  svgLibrary: Record<string, string>;
  platforms: Record<string, { displayName: string; svgIconKey: string; apps: SubpageApp[] }>;
}

export interface SubpageConfigInput {
  /** Absolute subscription URL, the same one `formats/page.ts` renders. */
  subUrl: string;
  /** Protocols actually present in THIS subscription. */
  protocols: readonly ProtocolName[];
  /** One entry per AmneziaWG node, with its AmneziaVPN `vpn://` key when the
   *  key could be built. Mirrors the per-node QR pairs on our own page. */
  awgNodes: ReadonlyArray<{
    nodeName: string;
    deviceIndex: number;
    vpnKey?: string;
  }>;
  /** One entry per plain-WireGuard tunnel — that is, per (node, device). */
  wgNodes: ReadonlyArray<{ nodeName: string; deviceIndex: number }>;
  /** One entry per MTProto node, with the `t.me/proxy` link Telegram imports. */
  mtprotoNodes: ReadonlyArray<{ nodeName: string; tmeUri: string }>;
  branding: { title: string; logoUrl: string; supportUrl: string };
  /** Formats that render at least one server for this buyer. A client whose
   *  format is not here would import an empty config. */
  usableFormats?: ReadonlySet<ClientFormat>;
}

// Our platform ids vs the shop's. `router` has no counterpart in the shop's
// ALLOWED_PLATFORMS (android, androidTV, appleTV, ios, linux, macos, windows),
// so router-only apps — Keenetic, OpenWrt — cannot be expressed in a v1
// document and are dropped here. wg-quick still reaches a router owner through
// the linux tab, which is where our own page lists it too.
const PLATFORM_TO_SHOP: Partial<Record<PlatformId, string>> = {
  ios: 'ios',
  android: 'android',
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  androidtv: 'androidTV',
  appletv: 'appleTV',
};

// svgIconKey is REQUIRED on a platform, so every mapped platform needs one that
// exists in the vendored library.
const PLATFORM_ICON_KEY: Record<string, string> = {
  ios: 'AppleIcon',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Ubuntu',
  androidTV: 'TV',
  appleTV: 'TV',
};

const PLATFORM_DISPLAY: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  androidTV: 'Android TV',
  appleTV: 'Apple TV',
};

// App icon keys the shop's vendored library happens to carry. Optional on an
// app (`_optional_svg_icon_key`), so an app we have no icon for — AmneziaVPN,
// WireGuard, WireSock, INCY, the Neko family — simply goes without rather than
// referencing a key that would fail validation and sink the document.
const APP_ICON_KEY: Record<string, string> = {
  Hiddify: 'Hiddify',
  // The vendored library already carried a Happ glyph while the catalogue had
  // no Happ to hang it on; the shop drew our list without the one client most
  // of its buyers actually run.
  Happ: 'Happ',
  'sing-box': 'Singbox',
  Streisand: 'Streisand',
  Shadowrocket: 'Shadowrocket',
  v2rayNG: 'VRayNG',
  'Clash Verge': 'ClashVerge',
  FlClash: 'FlClash',
};

// ─── "What you get" ─────────────────────────────────────────────────────────
//
// The install cards answer "how do I connect". They never answered "and what
// does this client actually give me", so a buyer picking Happ over sing-box had
// no way to know it hands back three channels instead of five, and a buyer on a
// link-list client had no way to know their bank would see a Dutch address.
//
// Everything below is derived from data that already decides something else —
// the catalogue's `protocols` (which apps are offered at all) and its `format`
// (which formats render for this buyer) — so a channel cannot be promised here
// without also being offered there.

/** Buyer-facing channel names. `xray` is VLESS on this fleet. */
const PROTOCOL_LABEL: Partial<Record<ProtocolName, string>> = {
  xray: 'VLESS',
  hysteria: 'Hysteria2',
  tuic: 'TUIC',
  anytls: 'AnyTLS',
  shadowtls: 'ShadowTLS',
  shadowsocks: 'Shadowsocks',
  mieru: 'Mieru',
  naive: 'NaiveProxy',
  wireguard: 'WireGuard',
  amneziawg: 'AmneziaWG',
  mtproto: 'MTProto',
};

/** Stable order, so two buyers with the same channels read the same sentence. */
const CHANNEL_ORDER: ProtocolName[] = [
  'xray',
  'tuic',
  'hysteria',
  'anytls',
  'shadowtls',
  'shadowsocks',
  'mieru',
  'naive',
  'amneziawg',
  'wireguard',
  'mtproto',
];

/**
 * One line about the client itself, where it says something the next card does
 * not. Deliberately sparse: an app with nothing distinctive gets no sentence
 * rather than filler that makes every card look the same.
 */
const APP_TRAIT: Record<string, Localized> = {
  Hiddify: {
    en: ' The quickest start: the subscription arrives with one tap.',
    ru: ' Самый быстрый старт: подписка добавляется одной кнопкой.',
  },
  'sing-box': {
    en: ' The one to take when you want to write your own routing rules.',
    ru: ' Его стоит брать, если хочется задать свои правила маршрутизации.',
  },
  'Clash Verge': {
    en: ' Servers and rules sit on one screen, switching is a click.',
    ru: ' Серверы и правила на одном экране, переключение в один клик.',
  },
  FlClash: {
    en: ' Servers and rules sit on one screen, switching is a click.',
    ru: ' Серверы и правила на одном экране, переключение в один клик.',
  },
};

/**
 * Clients whose Android build can route only chosen apps through the tunnel.
 * Android-only on purpose: this is the platform VPN API, and the same client on
 * iOS has no such control.
 */
const PER_APP_SPLIT = new Set(['Hiddify', 'sing-box', 'NekoBox', 'v2rayNG', 'FlClash']);

/** Router firmware that ships WireGuard, and the pages that document it. */
const WG_ROUTER_DOCS = 'https://www.wireguard.com/install/';
const AWG_ROUTER_KEENETIC = 'https://docs.amnezia.org/documentation/instructions/keenetic-os-awg/';
const AWG_ROUTER_OPENWRT = 'https://docs.amnezia.org/documentation/instructions/openwrt-os-awg/';

/**
 * Channels this app receives THROUGH ITS OWN import path.
 *
 * The catalogue's `protocols` answers a wider question — what the client can
 * speak at all — and Hiddify is why the two must not be confused: it reads
 * AmneziaWG configs, so the catalogue lists it, but the subscription link it
 * imports carries no tunnel. Promising AmneziaWG on that card would be a
 * channel the buyer cannot find in the app.
 */
const NOT_IN_A_SUBSCRIPTION: ReadonlySet<ProtocolName> = new Set([
  'wireguard',
  'amneziawg',
  'mtproto',
]);

/**
 * The channels this buyer would actually get FROM THIS APP, in reading order.
 *
 * Not `app.protocols`: that answers the wider "what can this client speak",
 * and the two differ wherever the import path drops something. Hiddify reads
 * AmneziaWG configs and imports a subscription, which carries no tunnel — so
 * the honest answer for Hiddify is "no AmneziaWG", and anything reasoning about
 * what an app gives a buyer has to ask this function rather than the field.
 */
function deliveredProtocols(app: AppDef, protocols: readonly ProtocolName[]): ProtocolName[] {
  const held = new Set(protocols);
  const viaSubscription = app.action.kind === 'deeplink' || app.action.kind === 'manual';
  return CHANNEL_ORDER.filter(
    (p) =>
      held.has(p) &&
      app.protocols.includes(p) &&
      !(viaSubscription && NOT_IN_A_SUBSCRIPTION.has(p)),
  );
}

function channelNames(app: AppDef, protocols: readonly ProtocolName[]): string[] {
  return deliveredProtocols(app, protocols)
    .map((p) => PROTOCOL_LABEL[p])
    .filter((label): label is string => !!label);
}

function joinList(items: string[], lang: 'en' | 'ru'): string {
  if (items.length <= 1) return items[0] ?? '';
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'и'} ${last}`;
}

function t(en: string, ru: string): Localized {
  return { en, ru };
}

/** Suffix a button label with the node name only when there is more than one
 *  node to tell apart — a single AmneziaWG server reads "AmneziaWG", not
 *  "AmneziaWG · London". Same rule our own page applies to its QR chips. */
function nodeSuffix(nodeName: string, many: boolean): string {
  return many ? ` · ${nodeName}` : '';
}

/**
 * Label suffix for one tunnel: the node when there are several, the device
 * when the buyer has more than one.
 *
 * Both are needed and neither on its own is enough - three devices across two
 * servers is six buttons, and a buyer looking at six identical labels cannot
 * tell which one they have not set up yet. Device 1 goes unmarked for the same
 * reason a single node does: most buyers have one, and a bare "· 1" only
 * raises the question of what it counts.
 */
function tunnelSuffix(
  nodeName: string,
  deviceIndex: number,
  manyNodes: boolean,
  manyDevices: boolean,
): string {
  const parts: string[] = [];
  if (manyNodes) parts.push(nodeName);
  if (manyDevices) parts.push(`#${deviceIndex}`);
  return parts.length > 0 ? ` · ${parts.join(' ')}` : '';
}

/**
 * The buyer's own subscription page, opened on ONE tunnel's QR.
 *
 * Same `proto`/`node`/`device` triple as the file link, minus `format`: the
 * page is what the panel serves a browser, and those three are what it uses to
 * decide which QR to open on.
 *
 * Why a link out at all. The shop draws exactly one QR and it is always the
 * subscription URL - true for every tab, including the WireGuard one. A wg
 * client's scanner reads that text as the body of a config, so the buyer gets
 * "no PrivateKey" from the QR shown on the page that told them to set up
 * WireGuard (measured 2026-09-03 with WG Tunnel). The shop has no per-button
 * QR to fix this with, and its CSS pins any SVG we could smuggle through
 * `svgLibrary` to 19x19 - unscannable. The panel's own page already draws the
 * right QR per tunnel, so the honest fix is to take the buyer there.
 */
function qrUrl(
  subUrl: string,
  proto: string,
  nodeName: string,
  deviceIndex: number,
): string {
  // `#scan` lands the buyer on the QR block itself. The block sits second on
  // the page as of 2026-09-03, so this is belt and braces rather than the fix -
  // but it is the half that survives a future reordering of the page.
  return `${subUrl}?proto=${proto}&node=${encodeURIComponent(nodeName)}&device=${deviceIndex}#scan`;
}

function fileUrl(
  subUrl: string,
  format: string,
  proto: string,
  nodeName: string,
  deviceIndex: number,
): string {
  return (
    `${subUrl}?format=${format}&proto=${proto}` +
    `&node=${encodeURIComponent(nodeName)}&device=${deviceIndex}`
  );
}

/**
 * The blocks for one app: how THIS buyer gets THIS app connected.
 *
 * Returns an empty list when the app's import path cannot be offered — an
 * AmneziaWG client with no AmneziaWG node behind it, say. The caller drops such
 * an app, because an app card with no blocks fails validation.
 */
/**
 * The step that has to come FIRST when it comes at all: this app cannot be
 * fetched from the store on this buyer's device.
 *
 * Above "install the app" on the customer's instruction and for the reason
 * they gave — buyers were tapping an install button that lands on a page their
 * account cannot open, and the tickets that followed were about our
 * instructions, not about the client. A note underneath the step it invalidates
 * is a note that arrives after the buyer has already tried.
 *
 * What it does NOT say is "use another app": the client keeps working on a
 * device that already has it, and that buyer is holding a working config. It
 * says what is true, and the two reasons say different true things — an Apple
 * account from another country is the answer to one of them and to neither the
 * other.
 */
function storeBlock(
  app: AppDef,
  reason: 'ru-storefront' | 'delisted',
  alternatives: string[],
): SubpageBlock {
  // Named from the tab as it was actually built, never from the catalogue: an
  // app with no checked link for this platform is not somewhere to send anyone,
  // and one carrying its own gap is the failure being described.
  const listEn = joinList(alternatives, 'en');
  const listRu = joinList(alternatives, 'ru');
  // "Without that restriction", never "from the store": on the macOS tab the
  // alternatives are Hiddify, sing-box and Clash Verge, and NONE of them comes
  // from a store — they are downloaded from the vendor's page and from GitHub.
  // Read on the live document 2026-09-05, where the first wording said "from
  // the store as usual" to a Mac owner about three apps that are not in it.
  const altEn = alternatives.length
    ? ` On this tab ${listEn} can be installed without that restriction, and works with this same subscription.`
    : '';
  // Singular and plural spelled out rather than one form that limps in the
  // other: this sentence is read by a person who is already stuck.
  const altRu = alternatives.length
    ? alternatives.length === 1
      ? ` На этой вкладке ${listRu} ставится без этого ограничения и работает с той же подпиской.`
      : ` На этой вкладке ${listRu} ставятся без этого ограничения и работают с той же подпиской.`
    : '';

  if (reason === 'delisted') {
    return {
      svgIconKey: 'AppleIcon',
      svgIconColor: 'amber',
      title: t('Not in the App Store right now', 'Сейчас нет в App Store'),
      description: t(
        `${app.name} is not in the App Store at all at the moment — its publisher cannot post it ` +
          'there, and this has nothing to do with the country of your account. If it is already ' +
          'installed it keeps working. Apps with similar names in the store are made by other ' +
          `people and are not this client.${altEn}`,
        `Приложения ${app.name} сейчас в App Store нет вовсе — издатель не может его там публиковать, ` +
          'и это не связано со страной вашего аккаунта. Если оно уже установлено, оно продолжает ' +
          'работать. ' +
          'Приложения с похожими названиями в магазине сделаны другими людьми и этим клиентом не ' +
          `являются.${altRu}`,
      ),
      buttons: [],
    };
  }

  return {
    svgIconKey: 'AppleIcon',
    svgIconColor: 'amber',
    title: t('Not in the Russian App Store', 'Нет в российском App Store'),
    description: t(
      `${app.name} is not available in the Russian App Store. If it is already installed it keeps ` +
        'working as before — but installing it again, on this or a new device, needs an Apple ' +
        `account registered in another country.${altEn}`,
      `Приложения ${app.name} нет в российском App Store. Если оно уже установлено, оно продолжает ` +
        'работать — но установить его заново, на этом или на новом устройстве, можно только с ' +
        `аккаунтом Apple другой страны.${altRu}`,
    ),
    buttons: [],
  };
}

/**
 * The one thing about this client only its owner can fix.
 *
 * A proxy client feeds the device through a local SOCKS listener, and on
 * Android the loopback is not isolated between apps: with authorisation off,
 * any app on the phone can use the buyer's tunnel. We cannot close it from
 * here — a server-side password was written, measured and reverted, because
 * with Happ's factory setting it kills the tunnel instead (`36ea18e4`).
 *
 * Two sentences rather than one, because the two clients need opposite advice:
 * telling an INCY owner to "turn it on" would send them looking for a switch
 * that is already thrown, and telling a Happ owner it is fine by default would
 * be false.
 */
/**
 * Where the setting actually lives, for the clients somebody has looked at on a
 * device.
 *
 * Kept apart from the sentence above because it is the half we cannot derive:
 * a menu path is read off a phone, and a guessed one is the failure this
 * deployment has already paid for twice. An app with no entry here gets the
 * sentence without the path — "open the app settings and find it" — rather than
 * a route invented to look complete.
 *
 * Happ, 2026-09-05, from the customer's own device.
 */
const LOCAL_PROXY_PATH: Record<string, Localized> = {
  Happ: {
    en: ' Open Settings (the gear), go to Inbounds, find the `socks` row and switch it from Disabled to Auto.',
    ru: ' Откройте настройки (шестерёнка) → «Входящие соединения» (Inbounds), найдите строку socks и вместо «Отключено» (Disabled) выберите режим «Авто» (Auto).',
  },
};

function localProxyBlock(app: AppDef): SubpageBlock | null {
  if (!app.localProxyAuth) return null;
  const path = LOCAL_PROXY_PATH[app.name];
  const shared = {
    en:
      ' With it off, any app on the device can go out through your tunnel — spending your ' +
      'traffic and using your address.',
    ru:
      ' При выключенной авторизации любое приложение на устройстве может выйти в сеть через ваш ' +
      'туннель — расходуя ваш трафик и выходя с вашего адреса.',
  };
  const en =
    app.localProxyAuth === 'off-by-default'
      ? `${app.name} leaves the authorisation of its local SOCKS proxy OFF out of the box.` +
        (path
          ? path.en
          : ' Open the app settings, find the local SOCKS proxy and set its authorisation mode to' +
            ' "Auto".') +
        ' The app then makes up a login and password and fills them in for itself, so there is ' +
        `nothing to type.${shared.en}`
      : `${app.name} asks for a login and password on its local SOCKS proxy out of the box, so there ` +
        'is nothing to do — but if you have ever switched that off, turn it back on in the app ' +
        `settings, in the mode where the app fills the credentials in itself.${shared.en}`;
  const ru =
    app.localProxyAuth === 'off-by-default'
      ? `В ${app.name} авторизация локального SOCKS-прокси по умолчанию ВЫКЛЮЧЕНА.` +
        (path
          ? path.ru
          : ' Откройте настройки приложения, найдите локальный SOCKS-прокси и поставьте режим' +
            ' авторизации «Авто».') +
        ' Приложение само придумает логин и пароль и подставит их себе, вводить ничего не ' +
        `нужно.${shared.ru}`
      : `В ${app.name} логин и пароль на локальном SOCKS-прокси спрашиваются по умолчанию — делать ` +
        'ничего не нужно. Но если вы когда-нибудь это отключали, включите обратно в настройках ' +
        `приложения, в режиме, где приложение подставляет их само.${shared.ru}`;
  return {
    svgIconKey: 'ShieldPlus',
    svgIconColor: 'rose',
    title: t('Close the local proxy', 'Закройте локальный прокси'),
    description: t(en, ru),
    buttons: [],
  };
}

/**
 * The "get the app" block, when there is a checked link for this platform.
 *
 * Absent for most of the catalogue on purpose (see InstallLinks): an install
 * page that names the app and links nowhere is thinner than the shop's own
 * guide, but a page that links to the wrong or a dead download is worse.
 */
function installBlock(app: AppDef, platform: PlatformId): SubpageBlock | null {
  const url = app.install?.[platform];
  if (!url) return null;
  return {
    svgIconKey: 'DownloadIcon',
    svgIconColor: 'violet',
    title: t('Install the app', 'Установите приложение'),
    description: t(
      `Open the page and install ${app.name}, then come back here.`,
      `Откройте страницу, установите ${app.name} и вернитесь сюда.`,
    ),
    buttons: [
      {
        type: 'external',
        link: url,
        text: t('Get the app', 'Скачать приложение'),
        svgIconKey: 'ExternalLink',
      },
    ],
  };
}

function blocksFor(app: AppDef, input: SubpageConfigInput): SubpageBlock[] {
  const { subUrl, awgNodes, wgNodes, mtprotoNodes } = input;

  switch (app.action.kind) {
    case 'deeplink':
      return [
        {
          svgIconKey: 'CloudDownload',
          svgIconColor: 'violet',
          title: t('Add the subscription', 'Добавьте подписку'),
          description: t(
            `Tap the button — ${app.name} opens and imports the subscription itself.`,
            `Нажмите кнопку — ${app.name} откроется и импортирует подписку сам.`,
          ),
          buttons: [
            {
              type: 'subscriptionLink',
              link: deeplinkHref(app.action.scheme, subUrl),
              text: t(`Open in ${app.name}`, `Открыть в ${app.name}`),
              svgIconKey: 'Plus',
            },
          ],
        },
      ];

    case 'manual':
      return [
        {
          svgIconKey: 'CloudDownload',
          svgIconColor: 'violet',
          title: t('Add the subscription', 'Добавьте подписку'),
          description: t(
            `Copy the link, then add it in ${app.name} as a subscription (or "add from URL").`,
            `Скопируйте ссылку и добавьте её в ${app.name} как подписку (или «добавить по URL»).`,
          ),
          buttons: [
            {
              type: 'copyButton',
              link: subUrl,
              text: t('Copy the link', 'Скопировать ссылку'),
              svgIconKey: 'ExternalLink',
            },
          ],
        },
      ];

    // The AmneziaVPN key. Our own page calls pasting the key the robust import
    // path — its QR is dense enough to be unreliable on screen — and the shop's
    // screen has no per-button QR at all, so copying is the ONLY path here.
    case 'awg-vpn': {
      if (awgNodes.length === 0) return [];
      const withKey = awgNodes.filter((n) => n.vpnKey);
      if (withKey.length === 0) return [];
      const many = new Set(withKey.map((n) => n.nodeName)).size > 1;
      const manyDevices = new Set(withKey.map((n) => n.deviceIndex)).size > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Paste the connection key', 'Вставьте ключ подключения'),
          description: t(
            `Copy the key, open ${app.name} and choose to add a connection from a key.`,
            `Скопируйте ключ, откройте ${app.name} и добавьте подключение из ключа.`,
          ),
          buttons: withKey.map((n) => ({
            type: 'copyButton' as const,
            link: n.vpnKey as string,
            text: t(
              `Copy the key${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
              `Скопировать ключ${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
            ),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }

    // MTProto: nothing to install and nothing to import. Telegram turns the
    // link into a "connect to this proxy" prompt, so the whole guide is the
    // link itself — one per node, because Telegram holds one proxy at a time.
    case 'endpoint-link': {
      if (mtprotoNodes.length === 0) return [];
      const many = mtprotoNodes.length > 1;
      return [
        {
          svgIconKey: 'ShieldPlus',
          svgIconColor: 'sky',
          title: t('Connect the proxy', 'Подключите прокси'),
          description: t(
            'Tap the button — Telegram will offer to connect to the proxy. Nothing to install.',
            'Нажмите кнопку — Telegram предложит подключиться к прокси. Устанавливать ничего не нужно.',
          ),
          buttons: mtprotoNodes.map((n) => ({
            type: 'external' as const,
            link: n.tmeUri,
            text: t(
              `Connect${nodeSuffix(n.nodeName, many)}`,
              `Подключить${nodeSuffix(n.nodeName, many)}`,
            ),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }

    // Both flavours hand out a wg-quick .conf; `proto=` pins which one, so a
    // node serving both tunnels still yields two distinct files.
    case 'awg-conf':
    case 'wg-conf':
    case 'download': {
      const isWg = app.protocols.includes('wireguard') && !app.protocols.includes('amneziawg');
      const nodes = isWg ? wgNodes : awgNodes;
      if (nodes.length === 0) return [];
      const many = new Set(nodes.map((n) => n.nodeName)).size > 1;
      const manyDevices = new Set(nodes.map((n) => n.deviceIndex)).size > 1;
      const proto = isWg ? 'wireguard' : 'amneziawg';
      const label = isWg ? 'WireGuard' : 'AmneziaWG';
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Download the config', 'Скачайте конфигурацию'),
          description: t(
            manyDevices
              ? `Download a .conf file and import it into ${app.name}. One file per device — use a different one on each.`
              : `Download the .conf file and import it into ${app.name}. One file per server.`,
            manyDevices
              ? `Скачайте файл .conf и импортируйте его в ${app.name}. По файлу на устройство — на каждом свой.`
              : `Скачайте файл .conf и импортируйте его в ${app.name}. По файлу на сервер.`,
          ),
          buttons: nodes.map((n) => ({
            type: 'external' as const,
            link: fileUrl(subUrl, 'wgconf', proto, n.nodeName, n.deviceIndex),
            text: t(
              `${label} (.conf)${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
              `${label} (.conf)${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
            ),
            svgIconKey: 'DownloadIcon',
          })),
        },
        {
          svgIconKey: 'ExternalLink',
          svgIconColor: 'sky',
          title: t('Or scan a QR code', 'Или отсканируйте QR-код'),
          description: t(
            `Opens the QR for this tunnel — scan it with ${app.name} and skip the file entirely. Importing a downloaded file is where phones make trouble: the name gets a "(1)" on a second download, and the app takes that name as the tunnel's own.`,
            `Откроется QR именно этого туннеля — отсканируйте его в ${app.name}, и файл не понадобится вовсе. Именно на импорте файла телефоны и капризничают: при повторном скачивании к имени добавляется «(1)», а приложение берёт это имя как имя туннеля.`,
          ),
          buttons: nodes.map((n) => ({
            type: 'external' as const,
            link: qrUrl(subUrl, proto, n.nodeName, n.deviceIndex),
            text: t(
              `QR${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
              `QR${tunnelSuffix(n.nodeName, n.deviceIndex, many, manyDevices)}`,
            ),
            svgIconKey: 'ExternalLink',
          })),
        },
      ];
    }
  }
}

/**
 * The "what you get" card: which channels this client actually receives, what
 * it does about Russian destinations, and the one thing worth knowing about it.
 *
 * Returns null when there is nothing true to say — an app the buyer holds no
 * channel for never reaches this point, and a card that only repeated the
 * install steps would be noise.
 *
 * The battery and router lines are properties of the protocols and of router
 * firmware, not measurements of ours; they are the only claims here that no
 * test can pin, so they stay qualitative.
 */
function givesBlock(
  app: AppDef,
  input: SubpageConfigInput,
  platform: PlatformId,
): SubpageBlock | null {
  const names = channelNames(app, input.protocols);
  if (names.length === 0) return null;
  const listEn = joinList(names, 'en');
  const listRu = joinList(names, 'ru');
  const buttons: SubpageButton[] = [];
  let en: string;
  let ru: string;

  if (app.action.kind === 'endpoint-link') {
    // MTProto lives inside Telegram, and Telegram holds one proxy at a time.
    // The conflict line is the support answer we would otherwise give twice a
    // week: a proxy that "stopped working" is usually a second tunnel that was
    // switched on next to it.
    en =
      `Channel: ${listEn}. It works inside Telegram only — no other app goes through it, ` +
      'and there is nothing to install. With another VPN or proxy running next to it the ' +
      'proxy can stop connecting: leave one of the two switched on.';
    ru =
      `Канал: ${listRu}. Работает только внутри Telegram — другие приложения через него не ходят, ` +
      'и устанавливать ничего не нужно. Рядом с другим включённым VPN или прокси он может ' +
      'перестать подключаться: оставьте что-то одно.';
  } else if (app.action.kind === 'deeplink' || app.action.kind === 'manual') {
    en =
      names.length > 1
        ? `Channels: ${listEn} — switched inside the app.`
        : `Channel: ${listEn}.`;
    ru =
      names.length > 1
        ? `Каналы: ${listRu} — переключаются прямо в приложении.`
        : `Канал: ${listRu}.`;
    if (app.format === 'plain') {
      // A link list is servers and nothing else. Saying so is the difference
      // between a buyer who knows why their bank refuses and one who writes in.
      en +=
        ' A link carries no routing rules, so everything goes through the VPN and Russian ' +
        'services — banks, Avito, 2GIS — may refuse to open. The rules are set in the app itself.';
      ru +=
        ' Ссылка правил маршрутизации не несёт: весь трафик идёт через VPN, поэтому российские ' +
        'сервисы — банки, Авито, 2ГИС — могут не открыться. Правила задаются в самом приложении.';
    } else if (app.format) {
      en +=
        ' The routing rules arrive with the config: Russian sites and banks open directly, ' +
        'ads are dropped.';
      ru +=
        ' Правила приезжают вместе с конфигом: российские сайты и банки открываются напрямую, ' +
        'реклама режется.';
    }
    // An app with no declared core gets neither sentence: which of the two is
    // true depends on the format it fetches, and guessing picks the one that
    // sends a buyer to support.
    if ((platform === 'android' || platform === 'androidtv') && PER_APP_SPLIT.has(app.name)) {
      en += ' On Android it can tunnel only the apps you choose.';
      ru += ' На Android в туннель можно пустить только выбранные приложения.';
    }
    const trait = APP_TRAIT[app.name];
    if (trait) {
      en += trait.en;
      ru += trait.ru;
    }
  } else {
    const isAwg = app.protocols.includes('amneziawg');
    en =
      `${names.length > 1 ? 'Channels' : 'Channel'}: ${listEn}. The whole device goes into the ` +
      'tunnel and the server decides what leaves directly. Of all the channels this one is the ' +
      'easiest on battery.';
    ru =
      `${names.length > 1 ? 'Каналы' : 'Канал'}: ${listRu}. В туннель уходит весь трафик, ` +
      'а что выпустить напрямую — решает сервер. Из всех каналов этот бережнее прочих к батарее.';
    if (app.action.kind !== 'awg-vpn') {
      // Only the .conf apps: a router owner imports the same file, and that is
      // the one place where "the whole home network" becomes true.
      en +=
        ' The same file goes into a router — Keenetic, ASUS, MikroTik, GL.iNet, OpenWrt — and ' +
        'then the whole home network is covered, TV and console included.';
      ru +=
        ' Тот же файл ставится на роутер — Keenetic, ASUS, MikroTik, GL.iNet, OpenWrt — и тогда ' +
        'защищена вся домашняя сеть, включая телевизор и консоль.';
      if (isAwg) {
        buttons.push(
          {
            type: 'external',
            link: AWG_ROUTER_KEENETIC,
            text: t('AmneziaWG on Keenetic', 'AmneziaWG на Keenetic'),
            svgIconKey: 'ExternalLink',
          },
          {
            type: 'external',
            link: AWG_ROUTER_OPENWRT,
            text: t('AmneziaWG on OpenWrt', 'AmneziaWG на OpenWrt'),
            svgIconKey: 'ExternalLink',
          },
        );
      } else {
        buttons.push({
          type: 'external',
          link: WG_ROUTER_DOCS,
          text: t('WireGuard on a router', 'WireGuard на роутере'),
          svgIconKey: 'ExternalLink',
        });
      }
    }
  }

  return {
    svgIconKey: 'Star',
    svgIconColor: 'blue',
    title: t('What you get', 'Что это даёт'),
    description: t(en, ru),
    buttons,
  };
}

/**
 * Build the document for one subscription, or `null` when this fleet has
 * nothing to say about it.
 *
 * `null` is a real answer, not a failure: the caller then replies as it always
 * has and the shop renders its own generic document. Emitting a document with
 * no platforms instead would be REJECTED by the shop's validator, which lands
 * the buyer in the same place by a noisier route.
 */
export function buildSubpageConfig(input: SubpageConfigInput): SubpageConfig | null {
  const platforms: SubpageConfig['platforms'] = {};

  for (const ours of PLATFORM_ORDER) {
    const shopKey = PLATFORM_TO_SHOP[ours];
    if (!shopKey) continue;

    // Two passes, because the store notice names the alternatives on this same
    // tab and those are not known until the tab is built. Naming them from the
    // catalogue instead would offer a buyer a client this subscription cannot
    // fill — the exact promise the rest of this file exists to refuse.
    const candidates = appsForPlatform(ours, input.protocols, input.usableFormats)
      .map((app) => ({ app, blocks: blocksFor(app, input) }))
      .filter((c) => c.blocks.length > 0);
    // An alternative has to be gettable, not merely listed: a checked install
    // link for THIS platform and no gap of its own. The first version of this
    // named sing-box to iPhone buyers as the client their store does sell — it
    // is the one app on that tab with no listing anywhere at all, which is the
    // whole reason it has no link. The list must be built from the same fields
    // that decide whether a buyer can get the app, or it invents a way out.
    const reachable = candidates
      .map((c) => c.app)
      .filter((a) => !a.storeGap?.[ours] && !!a.install?.[ours]);

    const apps: SubpageApp[] = [];
    for (const { app, blocks } of candidates) {
      const gap = app.storeGap?.[ours];
      // Install first, import second — that is the order a person does it in.
      const install = installBlock(app, ours);
      if (install) blocks.unshift(install);
      // And above install: a step that says the install button leads to a page
      // this buyer's account cannot open belongs before they tap it.
      if (gap) {
        // Alternatives that share a channel with this app, so the sentence
        // cannot send an AmneziaWG buyer to a subscription client. Three at
        // most: a longer list reads as a menu rather than a way out.
        const mine = new Set(deliveredProtocols(app, input.protocols));
        const alts = reachable
          .filter((a) => deliveredProtocols(a, input.protocols).some((pr) => mine.has(pr)))
          .map((a) => a.name)
          .filter((n, i, all) => all.indexOf(n) === i)
          .slice(0, 3);
        blocks.unshift(storeBlock(app, gap, alts));
      }
      // Before "what you get": it is an action, and actions come before the
      // description of what the client is.
      const localProxy = localProxyBlock(app);
      if (localProxy) blocks.push(localProxy);
      // Last card on purpose: a buyer who already knows the client scrolls past
      // it, one who is choosing reads it after seeing what installing involves.
      const gives = givesBlock(app, input, ours);
      if (gives) blocks.push(gives);
      const icon = APP_ICON_KEY[app.name];
      apps.push({
        name: app.name,
        ...(icon ? { svgIconKey: icon } : {}),
        // A client the buyer's own store does not sell is not the one to put a
        // "recommended" badge on, however good it is elsewhere. The flag stays
        // on the app — it is still the recommendation on Android and desktop —
        // and is suppressed here, on the tab where it cannot be acted on.
        featured: !!app.recommended && !gap,
        blocks,
      });
    }
    if (apps.length === 0) continue;

    platforms[shopKey] = {
      displayName: PLATFORM_DISPLAY[shopKey],
      svgIconKey: PLATFORM_ICON_KEY[shopKey],
      apps,
    };
  }

  if (Object.keys(platforms).length === 0) return null;

  return {
    version: '1',
    locales: [...SUBPAGE_LOCALES],
    brandingSettings: input.branding,
    uiConfig: { subscriptionInfoBlockType: 'collapsed', installationGuidesBlockType: 'cards' },
    baseSettings: {
      metaTitle: input.branding.title,
      metaDescription: input.branding.title,
      showConnectionKeys: true,
      hideGetLinkButton: false,
    },
    baseTranslations: BASE_TRANSLATIONS,
    svgLibrary: SVG_LIBRARY,
    platforms,
  };
}
