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
  'sing-box': 'Singbox',
  Streisand: 'Streisand',
  Shadowrocket: 'Shadowrocket',
  v2rayNG: 'VRayNG',
  'Clash Verge': 'ClashVerge',
  FlClash: 'FlClash',
};

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
            'Copy the key, open AmneziaVPN and choose to add a connection from a key.',
            'Скопируйте ключ, откройте AmneziaVPN и добавьте подключение из ключа.',
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
      ];
    }
  }
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

    const apps: SubpageApp[] = [];
    for (const app of appsForPlatform(ours, input.protocols, input.usableFormats)) {
      const blocks = blocksFor(app, input);
      if (blocks.length === 0) continue;
      // Install first, import second — that is the order a person does it in.
      const install = installBlock(app, ours);
      if (install) blocks.unshift(install);
      const icon = APP_ICON_KEY[app.name];
      apps.push({
        name: app.name,
        ...(icon ? { svgIconKey: icon } : {}),
        featured: !!app.recommended,
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
