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
// sharing one selection (`appsFor`) and one set of tunnel handouts
// (`pageHandouts`) with the subscription page is the entire point — the two
// install surfaces must not drift into promising different things.

import { FORMAT_DOORS, type Door, type ProtocolName, type SubscriptionFormat } from '@iceslab/shared';
import {
  PLATFORM_ORDER,
  appFormat,
  deeplinkHref,
  type AppDef,
  type PlatformId,
} from '../../subscription/subscription.page-apps.js';
import { appsFor } from '../../subscription/subscription.page.js';
import { tunnelFileUrl, tunnelScanUrl } from '../../subscription/subscription.tunnel-links.js';
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

/** A tunnel of the subscription, as `pageHandouts` lists it. `id` and `device`
 *  are what the per-node links carry in `node=` and `device=`. */
interface TunnelNode {
  nodeName: string;
  id?: string;
  device?: number;
}

export interface SubpageConfigInput {
  /** Absolute subscription URL, the same one the subscription page renders. */
  subUrl: string;
  /** Protocols actually present in THIS subscription. */
  protocols: readonly ProtocolName[];
  /** The formats a client may be offered for (`usableFormats`), as the page
   *  filters its tabs. Absent: no filtering. */
  usableFormats?: readonly SubscriptionFormat[];
  /** One entry per AmneziaWG node, with its AmneziaVPN `vpn://` key when the
   *  key could be built. Mirrors the per-node QR pairs on our own page. */
  awgNodes: ReadonlyArray<TunnelNode & { vpnKey?: string }>;
  /** One entry per plain-WireGuard node. */
  wgNodes: ReadonlyArray<TunnelNode>;
  /** One entry per MTProto node, with the `t.me/proxy` link Telegram imports. */
  mtprotoNodes: ReadonlyArray<{ nodeName: string; tmeUri: string }>;
  /** One Outline `ssconf://` key per Shadowsocks node Outline can read. */
  outlineNodes?: ReadonlyArray<{ nodeName: string; key: string }>;
  branding: { title: string; logoUrl: string; supportUrl: string };
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
  'sing-box': 'Singbox',
  Streisand: 'Streisand',
  Shadowrocket: 'Shadowrocket',
  v2rayNG: 'VRayNG',
  'Clash Verge': 'ClashVerge',
  FlClash: 'FlClash',
};

// MTProto is in no config format and the catalogue has no client for it: the
// client is Telegram, which takes the `t.me/proxy` link. It is added to these
// platforms by hand (the page draws it as its own card, not as an app).
const TELEGRAM_PLATFORMS: PlatformId[] = ['ios', 'android', 'windows', 'macos', 'linux'];

function t(en: string, ru: string): Localized {
  return { en, ru };
}

/** Suffix a button label with the node name only when there is more than one
 *  node to tell apart — a single AmneziaWG server reads "AmneziaWG", not
 *  "AmneziaWG · London". Same rule our own page applies to its QR chips. */
function nodeSuffix(nodeName: string, many: boolean): string {
  return many ? ` · ${nodeName}` : '';
}

// ─── "What you get" ─────────────────────────────────────────────────────────
//
// The install cards answer "how do I connect" and, until here, never "and what
// does this client give me". The list is computed from what already decides
// the rest: the client's format (`CLIENTS[id].format`, through `appFormat`),
// what that format carries (`FORMAT_DOORS`) and the protocols THIS subscription
// holds, so a channel cannot be promised here without also being served there.

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

/** Protocols that are a tunnel file or a proxy link, never a line of the
 *  subscription a client imports. */
const NOT_IN_A_SUBSCRIPTION: ReadonlySet<ProtocolName> = new Set(['wireguard', 'amneziawg', 'mtproto']);

/** The catalogue's protocol as the door of the format table (`doorOf`: an xray
 *  profile is vless unless it names another subprotocol, which a protocol list
 *  does not carry). */
function doorOfProtocol(p: ProtocolName): Door {
  return p === 'xray' ? 'vless' : p;
}

/**
 * The channels this buyer gets FROM THIS APP, in reading order.
 *
 * Not `app.protocols`: that is what the client can speak at all, and the two
 * differ wherever its import path drops something. Hiddify reads AmneziaWG
 * configs, yet the sing-box format it fetches carries no tunnel (FORMAT_DOORS),
 * so the honest answer for it is "no AmneziaWG". A tunnel app gets its tunnels,
 * Outline its Shadowsocks keys, and a subscription app what its format carries.
 */
function deliveredProtocols(app: AppDef, held: readonly ProtocolName[]): ProtocolName[] {
  const have = new Set(held);
  const format = appFormat(app);
  return CHANNEL_ORDER.filter((p) => {
    if (!have.has(p) || !app.protocols.includes(p)) return false;
    switch (app.action.kind) {
      case 'deeplink':
      case 'manual':
        return format
          ? FORMAT_DOORS[format][doorOfProtocol(p)].carried
          : !NOT_IN_A_SUBSCRIPTION.has(p);
      case 'outline':
        return p === 'shadowsocks';
      default:
        return p === 'amneziawg' || p === 'wireguard';
    }
  });
}

function joinList(items: string[], lang: 'en' | 'ru'): string {
  if (items.length <= 1) return items[0] ?? '';
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'и'} ${last}`;
}

/** The tunnels a tunnel app takes, by kind and node: "AmneziaWG (nl-1, de-2)". */
function tunnelNames(
  protocols: ProtocolName[],
  input: SubpageConfigInput,
): string[] {
  return protocols.map((p) => {
    const nodes = p === 'amneziawg' ? input.awgNodes : p === 'wireguard' ? input.wgNodes : [];
    const names = [...new Set(nodes.map((n) => n.nodeName))];
    return names.length > 0 ? `${PROTOCOL_LABEL[p]} (${names.join(', ')})` : (PROTOCOL_LABEL[p] ?? p);
  });
}

/**
 * The "what you get" block: which channels this client receives from this
 * buyer's subscription, and whether the routing rules travel with them.
 *
 * Null when there is nothing true to say. The card stands before the install
 * steps: the buyer is choosing, and "is this the client for me" is what the
 * steps cannot answer.
 */
function givesBlock(app: AppDef, input: SubpageConfigInput): SubpageBlock | null {
  const delivered = deliveredProtocols(app, input.protocols);
  if (delivered.length === 0) return null;
  const kind = app.action.kind;
  const viaSubscription = kind === 'deeplink' || kind === 'manual';
  const names = viaSubscription
    ? delivered.map((p) => PROTOCOL_LABEL[p] ?? p)
    : kind === 'outline'
      ? delivered.map((p) => PROTOCOL_LABEL[p] ?? p)
      : tunnelNames(delivered, input);
  const many = names.length > 1;
  const listEn = joinList(names, 'en');
  const listRu = joinList(names, 'ru');
  let en: string;
  let ru: string;
  if (viaSubscription) {
    en = many ? `Channels: ${listEn} — switched inside the app.` : `Channel: ${listEn}.`;
    ru = many ? `Каналы: ${listRu} — переключаются прямо в приложении.` : `Канал: ${listRu}.`;
    const format = appFormat(app);
    if (format === 'plain') {
      // A link list is servers and nothing else; saying so is the difference
      // between a buyer who knows why a bank refuses to open and one who writes in.
      en += ' A link carries no routing rules, so everything goes through the VPN. The rules are set in the app itself.';
      ru += ' Ссылка правил маршрутизации не несёт: весь трафик идёт через VPN. Правила задаются в самом приложении.';
    } else if (format) {
      en += ' The routing rules arrive with the config.';
      ru += ' Правила маршрутизации приезжают вместе с конфигом.';
    }
  } else if (kind === 'outline') {
    en = `Channel: ${listEn}. One key per server, no routing rules.`;
    ru = `Канал: ${listRu}. По ключу на сервер, правил маршрутизации нет.`;
  } else {
    en = `${many ? 'Tunnels' : 'Tunnel'}: ${listEn}. The whole device goes into the tunnel and the server decides what leaves directly.`;
    ru = `${many ? 'Туннели' : 'Туннель'}: ${listRu}. В туннель уходит весь трафик, а что выпустить напрямую — решает сервер.`;
  }
  return {
    svgIconKey: 'Star',
    svgIconColor: 'blue',
    title: t('What you get', 'Что это даёт'),
    description: t(en, ru),
    buttons: [],
  };
}

// ─── The store notice ───────────────────────────────────────────────────────

/** `2026-09-16` the way each locale writes a date. */
function dateIn(iso: string, lang: 'en' | 'ru'): string {
  const [y, m, d] = iso.split('-');
  return lang === 'en' ? iso : `${d}.${m}.${y}`;
}

/**
 * The "somebody else on this tab can be had instead" sentence, shared by the
 * two notices that interrupt an install: both are read by a person who is
 * already stuck, and only worth writing if they end somewhere.
 *
 * `obstacle` picks the escape. "Installed without that restriction" is for a
 * listing that will not open and reads as nonsense under a price, where the
 * thing worth saying is that the alternatives are free. Never "from the store":
 * on the macOS tab the alternatives are downloaded from the vendor's page.
 * Singular and plural are spelled out in Russian, gender-free on purpose (app
 * names have no gender to agree with).
 */
function alternativesSentence(alternatives: string[], obstacle: 'no-listing' | 'price'): Localized {
  if (alternatives.length === 0) return t('', '');
  const listEn = joinList(alternatives, 'en');
  const listRu = joinList(alternatives, 'ru');
  const many = alternatives.length > 1;
  if (obstacle === 'price') {
    return t(
      ` On this tab ${listEn} ${many ? 'are' : 'is'} free and ${many ? 'work' : 'works'} with this same subscription.`,
      many
        ? ` На этой вкладке ${listRu} ставятся бесплатно и работают с той же подпиской.`
        : ` На этой вкладке ${listRu} ставится бесплатно и работает с той же подпиской.`,
    );
  }
  return t(
    ` On this tab ${listEn} can be installed without that restriction, and works with this same subscription.`,
    many
      ? ` На этой вкладке ${listRu} ставятся без этого ограничения и работают с той же подпиской.`
      : ` На этой вкладке ${listRu} ставится без этого ограничения и работает с той же подпиской.`,
  );
}

/**
 * The notice for an app the store does not carry for this buyer, first in the
 * card because it can make the whole card moot: an install button that lands on
 * a page the account cannot open is how the tickets began.
 *
 * It does NOT say "use another app": the client keeps working where it is
 * already installed. The two reasons say different true things, and only one of
 * them is answered by an Apple account from another country.
 */
function storeBlock(app: AppDef, reason: 'ru-storefront' | 'delisted', alternatives: string[]): SubpageBlock {
  const { en: altEn, ru: altRu } = alternativesSentence(alternatives, 'no-listing');
  // Every sentence sends the buyer to search the store for this name, so where
  // the search has an answer that is not us, saying so is part of the warning.
  const alikeEn = app.storeNameAlike
    ? ' Apps with similar names in the store are made by other people and are not this client.'
    : '';
  const alikeRu = app.storeNameAlike
    ? ' Приложения с похожими названиями в магазине сделаны другими людьми и этим клиентом не являются.'
    : '';
  if (reason === 'delisted') {
    return {
      svgIconKey: 'AppleIcon',
      svgIconColor: 'amber',
      title: t('Not in the App Store right now', 'Сейчас нет в App Store'),
      description: t(
        `${app.name} is not in the App Store at all at the moment — its publisher cannot post it ` +
          'there, and this has nothing to do with the country of your account. If it is already ' +
          `installed it keeps working.${alikeEn}${altEn}`,
        `Приложения ${app.name} сейчас в App Store нет вовсе — издатель не может его там публиковать, ` +
          'и это не связано со страной вашего аккаунта. Если оно уже установлено, оно продолжает ' +
          `работать.${alikeRu}${altRu}`,
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
        `account registered in another country.${alikeEn}${altEn}`,
      `Приложения ${app.name} нет в российском App Store. Если оно уже установлено, оно продолжает ` +
        'работать — но установить его заново, на этом или на новом устройстве, можно только с ' +
        `аккаунтом Apple другой страны.${alikeRu}${altRu}`,
    ),
    buttons: [],
  };
}

/**
 * The same place, the other way an install stops: the store has the app and
 * wants money for it. The price is DATED in the text, from the catalogue's
 * measurement date, and the store page is named as the authority, because a
 * price drifts. Only the price: the listing also carries in-app purchases, so
 * "a one-off purchase" would be false.
 */
function paidBlock(app: AppDef, price: string, alternatives: string[]): SubpageBlock {
  const alt = alternativesSentence(alternatives, 'price');
  const asOf = app.storePriceAsOf;
  return {
    svgIconKey: 'AppleIcon',
    svgIconColor: 'amber',
    title: t('A paid app', 'Платное приложение'),
    description: t(
      `${app.name} costs money in the Russian App Store — ${price}${asOf ? ` as measured on ${dateIn(asOf, 'en')}` : ''}. ` +
        `The store page always shows the current price.${alt.en}`,
      `${app.name} в российском App Store платный — ${price}${asOf ? ` по замеру на ${dateIn(asOf, 'ru')}` : ''}. ` +
        `Актуальную цену всегда показывает сама страница магазина.${alt.ru}`,
    ),
    buttons: [],
  };
}

/**
 * The "get the app" block, when the catalogue names a page for it.
 *
 * Absent for an app with no `site` on purpose: an install page that names the
 * app and links nowhere is thinner than the shop's own guide, but a page that
 * links to a wrong or dead download is worse.
 */
function installBlock(app: AppDef): SubpageBlock | null {
  if (!app.site) return null;
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
        link: app.site,
        text: t('Get the app', 'Скачать приложение'),
        svgIconKey: 'ExternalLink',
      },
    ],
  };
}

/**
 * The blocks for one app: how THIS buyer gets THIS app connected.
 *
 * Returns an empty list when the app's import path cannot be offered — an
 * AmneziaWG client with no AmneziaWG node behind it, say. The caller drops such
 * an app, because an app card with no blocks fails validation.
 */
function blocksFor(app: AppDef, input: SubpageConfigInput): SubpageBlock[] {
  const { subUrl, awgNodes, wgNodes } = input;

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
      const withKey = awgNodes.filter((n) => n.vpnKey);
      if (withKey.length === 0) return [];
      const many = withKey.length > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Paste the connection key', 'Вставьте ключ подключения'),
          description: t(
            'Copy the key, open AmneziaVPN and choose to add a connection from a key.',
            'Скопируйте ключ, откройте AmneziaVPN и добавьте подключение из ключа.',
          ),
          buttons: withKey.map((n) => ({
            type: 'copyButton' as const,
            link: n.vpnKey as string,
            text: t(
              `Copy the key${nodeSuffix(n.nodeName, many)}`,
              `Скопировать ключ${nodeSuffix(n.nodeName, many)}`,
            ),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }

    // An Outline key carries one server: a key per node, copied.
    case 'outline': {
      const keys = input.outlineNodes ?? [];
      if (keys.length === 0) return [];
      const many = keys.length > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Paste the access key', 'Вставьте ключ доступа'),
          description: t(
            'Copy the key, open Outline and add a server from it. One key per server.',
            'Скопируйте ключ, откройте Outline и добавьте сервер по ключу. По ключу на сервер.',
          ),
          buttons: keys.map((n) => ({
            type: 'copyButton' as const,
            link: n.key,
            text: t(
              `Copy the key${nodeSuffix(n.nodeName, many)}`,
              `Скопировать ключ${nodeSuffix(n.nodeName, many)}`,
            ),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }

    // Both flavours hand out a wg-quick .conf; `protocols=` pins which one, so
    // a node serving both tunnels still yields two distinct files. The kind
    // follows what the app reads: AmneziaWG clients take the AmneziaWG files,
    // stock WireGuard ones the plain files, and a wg-quick download both.
    case 'awg-conf':
    case 'wg-conf':
    case 'download': {
      const reads = (p: ProtocolName) => app.protocols.includes(p);
      const files = [
        ...(reads('amneziawg')
          ? awgNodes.map((n) => ({ n, proto: 'amneziawg' as const }))
          : []),
        ...(reads('wireguard')
          ? wgNodes.map((n) => ({ n, proto: 'wireguard' as const }))
          : []),
      ];
      if (files.length === 0) return [];
      const many = files.length > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Download the config', 'Скачайте конфигурацию'),
          description: t(
            `Download the .conf file and import it into ${app.name}. One file per server.`,
            `Скачайте файл .conf и импортируйте его в ${app.name}. По файлу на сервер.`,
          ),
          buttons: files.map(({ n, proto }) => {
            const label = proto === 'wireguard' ? 'WireGuard' : 'AmneziaWG';
            const text = `${label} (.conf)${nodeSuffix(n.nodeName, many)}`;
            return {
              type: 'external' as const,
              link: tunnelFileUrl(subUrl, proto, n),
              text: t(text, text),
              svgIconKey: 'DownloadIcon',
            };
          }),
        },
        // The shop draws one QR and it is the subscription URL, which a
        // WireGuard scanner reads as the body of a config. The panel's own page
        // draws the right QR per tunnel, so the button takes the buyer there,
        // on that tunnel (the `?node=` preselect of 13.2, which a portal
        // redirect leaves alone).
        {
          svgIconKey: 'ExternalLink',
          svgIconColor: 'sky',
          title: t('Or scan a QR code', 'Или отсканируйте QR-код'),
          description: t(
            `Opens the QR for this tunnel — scan it with ${app.name} and skip the file entirely.`,
            `Откроется QR именно этого туннеля — отсканируйте его в ${app.name}, и файл не понадобится вовсе.`,
          ),
          buttons: files.map(({ n, proto }) => {
            const label = proto === 'wireguard' ? 'WireGuard' : 'AmneziaWG';
            const text = `QR ${label}${nodeSuffix(n.nodeName, many)}`;
            return {
              type: 'external' as const,
              link: tunnelScanUrl(subUrl, n),
              text: t(text, text),
              svgIconKey: 'ExternalLink',
            };
          }),
        },
      ];
    }
  }
}

/** The Telegram card: nothing to install and nothing to import. Telegram turns
 *  the link into a "connect to this proxy" prompt, so the whole guide is the
 *  link itself — one per node, because Telegram holds one proxy at a time. */
function telegramApp(nodes: SubpageConfigInput['mtprotoNodes']): SubpageApp {
  const many = nodes.length > 1;
  return {
    name: 'Telegram',
    featured: true,
    blocks: [
      {
        svgIconKey: 'Star',
        svgIconColor: 'blue',
        title: t('What you get', 'Что это даёт'),
        description: t(
          'Channel: MTProto. It works inside Telegram only — no other app goes through it, and there ' +
            'is nothing to install. With another VPN or proxy running next to it the proxy can stop ' +
            'connecting: leave one of the two switched on.',
          'Канал: MTProto. Работает только внутри Telegram — другие приложения через него не ходят, ' +
            'и устанавливать ничего не нужно. Рядом с другим включённым VPN или прокси он может ' +
            'перестать подключаться: оставьте что-то одно.',
        ),
        buttons: [],
      },
      {
        svgIconKey: 'ShieldPlus',
        svgIconColor: 'sky',
        title: t('Connect the proxy', 'Подключите прокси'),
        description: t(
          'Tap the button — Telegram will offer to connect to the proxy. Nothing to install.',
          'Нажмите кнопку — Telegram предложит подключиться к прокси. Устанавливать ничего не нужно.',
        ),
        buttons: nodes.map((n) => ({
          type: 'external' as const,
          link: n.tmeUri,
          text: t(
            `Connect${nodeSuffix(n.nodeName, many)}`,
            `Подключить${nodeSuffix(n.nodeName, many)}`,
          ),
          svgIconKey: 'Plus',
        })),
      },
    ],
  };
}

/**
 * What each channel of the subscription is good at and what it costs, one entry
 * per protocol a client imports from the link.
 *
 * Only the "other client" card renders these, and only for the channels THIS
 * buyer holds: that card cannot say which client it is or what it does, so the
 * useful thing left to describe is the subscription itself. The deployment
 * claims are read rather than recalled: the self-signed certificates and
 * `insecure=1` are how these inbounds are configured here, and ShadowTLS having
 * no share link is why `subscription.service.ts` emits `uri: ''` for it. Two
 * sentences each: a buyer opens this card when something did not work.
 */
const CHANNEL_NOTE: Partial<Record<ProtocolName, Localized>> = {
  xray: t(
    'The main channel here and the one to start with: it runs over TCP and hides inside what ' +
      'looks like an ordinary TLS connection to a real website, so it survives strict filtering. ' +
      'Of the channels here it is the one the most clients speak.',
    'Основной канал и тот, с которого стоит начинать: работает поверх TCP и прячется внутри ' +
      'того, что выглядит как обычное TLS-соединение с настоящим сайтом, поэтому переживает ' +
      'жёсткую фильтрацию. Из перечисленных каналов его поддерживают больше всего приложений.',
  ),
  tuic: t(
    'Runs over QUIC, that is over UDP: on a flaky mobile network it recovers from losses faster ' +
      'than the TCP channels. The cost is the same UDP — some providers throttle or block it, and ' +
      'then this line simply will not connect while the others do.',
    'Работает по QUIC, то есть поверх UDP: на капризной мобильной сети он переносит потери ' +
      'лучше, чем каналы на TCP. Цена — тот же UDP: часть провайдеров его режет или блокирует, и ' +
      'тогда эта строка просто не подключится, а остальные будут работать.',
  ),
  hysteria: t(
    'Also UDP, and built for bad links: where the rest crawl on a lossy or high-latency network ' +
      'this one is usually the fastest. Two costs: the same UDP as above, and our certificate is ' +
      'self-signed, so the link carries insecure=1 and a client that ignores it refuses to ' +
      'connect.',
    'Тоже UDP и сделан ради плохих каналов: там, где остальные еле тянут на потерях и большой ' +
      'задержке, он обычно самый быстрый. Цены две: тот же UDP, что выше, и наш сертификат ' +
      'самоподписанный — в ссылке стоит insecure=1, и приложение, которое это поле игнорирует, ' +
      'подключаться откажется.',
  ),
  anytls: t(
    'TCP again, and it looks like plain TLS — a good fallback for a network where UDP is dead. ' +
      'It is a young protocol, so fewer clients support it, and its certificate is self-signed ' +
      'like Hysteria2.',
    'Снова TCP, и выглядит как обычный TLS — хороший запасной вариант там, где UDP не ходит. ' +
      'Протокол молодой, поэтому его поддерживают не все приложения, а сертификат у него ' +
      'самоподписанный, как у Hysteria2.',
  ),
  shadowtls: t(
    'Hides inside a handshake with a real site, which makes it quiet. It has no share link at ' +
      'all, though: it exists only inside a whole configuration file, so a client that imports a ' +
      'list of links never sees this channel however capable it is.',
    'Прячется внутри рукопожатия с настоящим сайтом и потому малозаметен. Но у него нет ' +
      'ссылки вовсе: он существует только внутри целого файла конфигурации, поэтому приложение, ' +
      'импортирующее список ссылок, этого канала не увидит, каким бы хорошим оно ни было.',
  ),
  shadowsocks: t(
    'The oldest and most widely supported of the list — if a client speaks only one thing, it ' +
      'is usually this. It carries no camouflage of its own, so a provider that looks closely ' +
      'spots it sooner than the channels above.',
    'Самый старый и самый широко поддерживаемый из списка — если приложение умеет что-то одно, ' +
      'то обычно именно его. Собственной маскировки у него нет, поэтому провайдер, который ' +
      'смотрит внимательно, замечает его раньше остальных.',
  ),
};

/**
 * The card for "I use a client you did not name": one block per channel the
 * buyer's subscription carries — the subscription link (with a note per
 * protocol in it), the tunnel files, the Telegram proxy links — and no "what
 * you get" block, which would be a promise about an app nobody identified.
 *
 * Built apart from `blocksFor` because every sentence there names an app. A
 * channel the buyer does not hold has no block: a tunnel-only buyer's link
 * serves 0 bytes, so "paste this into any client" is exactly the working client
 * aimed at nothing this file refuses. Null when no VPN channel is left (a
 * Telegram-only buyer has the Telegram card already).
 */
function genericApp(input: SubpageConfigInput): SubpageApp | null {
  const held = new Set(input.protocols);
  const lineProtocols = CHANNEL_ORDER.filter(
    (p) => held.has(p) && !NOT_IN_A_SUBSCRIPTION.has(p) && CHANNEL_NOTE[p],
  );
  const hasLink = lineProtocols.length > 0 && input.subUrl !== '';
  const awgFiles = held.has('amneziawg') ? input.awgNodes : [];
  const wgFiles = held.has('wireguard') ? input.wgNodes : [];
  const files = [
    ...awgFiles.map((n) => ({ n, proto: 'amneziawg' as const })),
    ...wgFiles.map((n) => ({ n, proto: 'wireguard' as const })),
  ];
  if (!hasLink && files.length === 0) return null;

  const partial = hasLink
    ? t(
        ' Clients differ in what they read, so yours may show only some of the lines below — that is normal, and the ones it does show work.',
        ' Клиенты читают разное, поэтому ваш может показать не все строки из перечисленных ниже — это нормально, а те, что показал, работают.',
      )
    : t('', '');
  const blocks: SubpageBlock[] = [
    {
      svgIconKey: 'Star',
      svgIconColor: 'blue',
      title: t('Any client will do', 'Подойдёт любой клиент'),
      description: t(
        'We do not limit which app you use: if you already have a favourite, take it — the apps ' +
          `this guide names are the ones we have checked ourselves, not a closed set.${partial.en}`,
        'Мы не ограничиваем вас в выборе приложения: если у вас уже есть привычный, берите его — ' +
          'приложения, которые мы называем в инструкции, — то, что мы проверили сами, а не ' +
          `закрытый перечень.${partial.ru}`,
      ),
      buttons: [],
    },
  ];

  // One block per channel, not a list: the shop renders a description as one
  // paragraph with no line breaks (InstallGuideScreen.svelte).
  if (hasLink) {
    for (const p of lineProtocols) {
      const label = PROTOCOL_LABEL[p] as string;
      blocks.push({
        svgIconKey: 'Check',
        svgIconColor: 'sky',
        title: t(label, label),
        description: CHANNEL_NOTE[p] as Localized,
        buttons: [],
      });
    }
    blocks.push({
      svgIconKey: 'CloudDownload',
      svgIconColor: 'violet',
      title: t('Add the subscription', 'Добавьте подписку'),
      description: t(
        'Copy the link with the button below and add it in your app as a subscription — the menu ' +
          'item is usually called "Add from URL", "Import from URL" or "Subscribe".',
        'Скопируйте ссылку кнопкой ниже и добавьте её в своём приложении как подписку — пункт меню ' +
          'обычно называется «Добавить по URL», «Import from URL» или «Subscribe».',
      ),
      buttons: [
        {
          type: 'copyButton',
          link: input.subUrl,
          text: t('Copy the link', 'Скопировать ссылку'),
          svgIconKey: 'ExternalLink',
        },
      ],
    });
  }

  if (files.length > 0) {
    const many = files.length > 1;
    blocks.push({
      svgIconKey: 'DownloadIcon',
      svgIconColor: 'emerald',
      title: t('Tunnel files', 'Файлы туннелей'),
      description: t(
        'A standard wg-quick .conf, one per server: any WireGuard client reads it, and an AmneziaWG ' +
          'file needs a client that knows AmneziaWG.',
        'Стандартный .conf для wg-quick, по файлу на сервер: его читает любой клиент WireGuard, а ' +
          'файл AmneziaWG — только клиент, который знает AmneziaWG.',
      ),
      buttons: files.map(({ n, proto }) => {
        const label = proto === 'wireguard' ? 'WireGuard' : 'AmneziaWG';
        const text = `${label} (.conf)${nodeSuffix(n.nodeName, many)}`;
        return {
          type: 'external' as const,
          link: tunnelFileUrl(input.subUrl, proto, n),
          text: t(text, text),
          svgIconKey: 'DownloadIcon',
        };
      }),
    });
  }

  if (held.has('mtproto') && input.mtprotoNodes.length > 0) {
    const nodes = input.mtprotoNodes;
    blocks.push({
      svgIconKey: 'ShieldPlus',
      svgIconColor: 'sky',
      title: t('Telegram proxy', 'Прокси для Telegram'),
      description: t(
        'The MTProto line is for Telegram rather than for a VPN client — Telegram connects it itself.',
        'Строка MTProto предназначена Telegram, а не VPN-приложению — мессенджер подключает её сам.',
      ),
      buttons: nodes.map((n) => ({
        type: 'external' as const,
        link: n.tmeUri,
        text: t(
          `Connect${nodeSuffix(n.nodeName, nodes.length > 1)}`,
          `Подключить${nodeSuffix(n.nodeName, nodes.length > 1)}`,
        ),
        svgIconKey: 'Plus',
      })),
    });
  }

  return { name: 'Другой клиент', featured: false, blocks };
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
  // The page's own flags: a tunnel client shows when the buyer holds a tunnel,
  // Outline when there is a key for it.
  const hasAwg = input.awgNodes.length > 0 || input.wgNodes.length > 0;
  const hasOutline = (input.outlineNodes?.length ?? 0) > 0;
  const telegram = input.protocols.includes('mtproto') && input.mtprotoNodes.length > 0;
  const generic = genericApp(input);

  for (const ours of PLATFORM_ORDER) {
    const shopKey = PLATFORM_TO_SHOP[ours];
    if (!shopKey) continue;

    // Two passes: the store notice names the alternatives on this same tab, and
    // those are not known until the tab is built. Naming them from the catalogue
    // would offer a client this subscription cannot fill.
    const candidates = appsFor(
      ours,
      [...input.protocols],
      hasAwg,
      hasOutline,
      input.usableFormats ? [...input.usableFormats] : undefined,
    )
      .map((app) => ({ app, blocks: blocksFor(app, input) }))
      .filter((c) => c.blocks.length > 0);
    // An alternative has to be gettable, not merely listed: a page to get it
    // from, no gap of its own and no price. A paid app is not a way out of a
    // page that would not open, nor out of a price.
    const reachable = candidates
      .map((c) => c.app)
      .filter((a) => !a.storeGap?.[ours] && !a.storePrice?.[ours] && !!a.site);

    const apps: SubpageApp[] = [];
    for (const { app, blocks } of candidates) {
      // Install first, import second — that is the order a person does it in.
      const install = installBlock(app);
      if (install) blocks.unshift(install);
      // Above install: the buyer is choosing, and "is this the client for me"
      // is what install cannot answer.
      const gives = givesBlock(app, input);
      if (gives) blocks.unshift(gives);
      // And above that, because it can make the whole card moot. A storefront
      // cannot both refuse an app and quote a price for it, so the two are
      // exclusive per platform.
      const gap = app.storeGap?.[ours];
      const price = app.storePrice?.[ours];
      if (gap || price) {
        // Alternatives that share a channel with this app, so the sentence
        // cannot send an AmneziaWG buyer to a subscription client. Three at
        // most: a longer list reads as a menu rather than a way out.
        const mine = new Set(deliveredProtocols(app, input.protocols));
        const alts = reachable
          .filter((a) => deliveredProtocols(a, input.protocols).some((p) => mine.has(p)))
          .map((a) => a.name)
          .slice(0, 3);
        blocks.unshift(gap ? storeBlock(app, gap, alts) : paidBlock(app, price as string, alts));
      }
      const icon = APP_ICON_KEY[app.name];
      apps.push({
        name: app.name,
        ...(icon ? { svgIconKey: icon } : {}),
        featured: !!app.recommended,
        blocks,
      });
    }
    if (telegram && TELEGRAM_PLATFORMS.includes(ours)) apps.push(telegramApp(input.mtprotoNodes));
    if (apps.length === 0) continue;
    // Last on every tab that has an app to offer; it does not make a tab of its own.
    if (generic) apps.push(generic);

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
