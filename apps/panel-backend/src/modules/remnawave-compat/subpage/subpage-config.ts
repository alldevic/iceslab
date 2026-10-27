// The install screen a shop draws from the compatibility API (Subscription
// Page v1), built from what the panel's own subscription page shows the same
// person.
//
// The shop asks the panel, in order: `GET /subscriptions/subpage-config/
// {shortUuid}` (a document for ONE subscription; the short uuid here is the
// subscription token), then the shared list `GET /subscription-page-configs`
// and one of its entries by uuid. Answering `{}` everywhere threw the first
// question away: the shop logged a warning and drew its bundled document,
// which knows nothing about this fleet (no AmneziaWG client, no Telegram), or
// nothing at all where its data volume holds no default.
//
// The apps, their order and their ways in are the subscription page's:
// `appsFor` (which apps a platform offers for these protocols, the per-node
// handouts included), the registry in subscription.page-apps.ts (names and
// download pages from packages/shared/src/clients.ts), and `pageHandouts` (the
// tunnels, keys and proxy links). Nothing here decides who gets which client;
// it only says it in the shop's shape, so the two install surfaces cannot drift
// into promising different things.
//
// What the shop does with the document, read from its source (v3.6.1):
//   - `InstallGuideScreen.svelte` renders `platforms`, `svgLibrary` and two
//     `baseTranslations` keys. The rest is validated and never shown.
//   - A button either copies (`copyButton`) or opens (every other type). There
//     is no per-button QR: the one QR on the screen is always the
//     subscription link, useless to a WireGuard client. So tunnel apps get a
//     key to copy or a file to open, and a link to our page, which draws the
//     QR per tunnel.
//   - The validator rejects a platform with no apps and an app with no blocks,
//     and either fails the whole document. Such ones are left out.
//   - `{{SUBSCRIPTION_LINK}}` in a link is replaced with the person's link by
//     plain substitution. The shared document has no person, so it uses that,
//     and only in links that carry the URL unencoded.

import type { ProtocolName } from '@iceslab/shared';
import { PLATFORM_ORDER, deeplinkHref, type AppDef, type PlatformId } from '../../subscription/subscription.page-apps.js';
import { appsFor, awgLabel, awgQuery, TELEGRAM_PLATFORMS } from '../../subscription/subscription.page.js';
import { withQuery } from '../../subscription/subscription.protocols.js';
import { L } from '../../subscription/subscription.page-text.js';
import type { PageHandouts } from '../../subscription/subscription.page-handouts.js';
import { BASE_TRANSLATIONS, SUBPAGE_LOCALES, SVG_LIBRARY } from './chrome.js';

/** A string in every locale the document declares; the shop's validator
 *  requires all of them on every localized field. */
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

/** The shop's placeholder for the person's subscription link. */
export const SUBSCRIPTION_LINK_PLACEHOLDER = '{{SUBSCRIPTION_LINK}}';

export interface SubpageConfigInput {
  /** The person's subscription URL, or SUBSCRIPTION_LINK_PLACEHOLDER for the
   *  shared document. */
  subUrl: string;
  handouts: Pick<PageHandouts, 'protocols' | 'awgNodes' | 'mtprotoNodes' | 'telegramProxies' | 'outlineNodes'>;
  branding: { title: string; logoUrl: string; supportUrl: string };
}

// Our platforms against the shop's ALLOWED_PLATFORMS. `router` has no
// counterpart there, so router-only apps (Keenetic, OpenWrt, XKeen) cannot be
// expressed; wg-quick still reaches a router owner through the linux tab, as
// on our page.
const PLATFORM_TO_SHOP: Partial<Record<PlatformId, string>> = {
  ios: 'ios',
  android: 'android',
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  androidtv: 'androidTV',
  appletv: 'appleTV',
};

// Required on a platform, and every key must exist in the vendored library.
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

/** Deep links that carry the subscription URL as it is, so the shop's
 *  placeholder survives in them. The others encode it (v2rayng, clash,
 *  sing-box) or base64 it (shadowrocket). */
const RAW_URL_SCHEMES = new Set(['hiddify', 'streisand', 'happ', 'v2raytun']);

function t(en: string, ru: string): Localized {
  return { en, ru };
}

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
    buttons: [{ type: 'external', link: app.site, text: t('Get the app', 'Скачать приложение'), svgIconKey: 'ExternalLink' }],
  };
}

function copyLinkBlock(app: AppDef, subUrl: string): SubpageBlock {
  return {
    svgIconKey: 'CloudDownload',
    svgIconColor: 'violet',
    title: t('Add the subscription', 'Добавьте подписку'),
    description: t(
      `Copy the link, then add it in ${app.name} as a subscription ("add from URL").`,
      `Скопируйте ссылку и добавьте её в ${app.name} как подписку («добавить по URL»).`,
    ),
    buttons: [{ type: 'copyButton', link: subUrl, text: t('Copy the link', 'Скопировать ссылку'), svgIconKey: 'ExternalLink' }],
  };
}

/** The label of one tunnel's button: the node (and device from 2 on) only
 *  when there is more than one to tell apart. */
function tunnelText(en: string, ru: string, label: string, many: boolean): Localized {
  return many ? t(`${en} · ${label}`, `${ru} · ${label}`) : t(en, ru);
}

/** How THIS person connects THIS app, in the order they do it. Empty when the
 *  app's way in has nothing behind it for them. */
function importBlocks(app: AppDef, input: SubpageConfigInput): SubpageBlock[] {
  const { subUrl, handouts } = input;
  const personal = subUrl !== SUBSCRIPTION_LINK_PLACEHOLDER;
  const a = app.action;
  switch (a.kind) {
    case 'deeplink': {
      if (!personal && !RAW_URL_SCHEMES.has(a.scheme)) return [copyLinkBlock(app, subUrl)];
      return [
        {
          svgIconKey: 'CloudDownload',
          svgIconColor: 'violet',
          title: t('Add the subscription', 'Добавьте подписку'),
          description: t(
            `Tap the button: ${app.name} opens and imports the subscription itself.`,
            `Нажмите кнопку: ${app.name} откроется и импортирует подписку сам.`,
          ),
          buttons: [
            {
              type: 'subscriptionLink',
              link: deeplinkHref(a.scheme, subUrl),
              text: t(`Open in ${app.name}`, `Открыть в ${app.name}`),
              svgIconKey: 'Plus',
            },
          ],
        },
      ];
    }
    case 'manual':
      return [copyLinkBlock(app, subUrl)];

    // The AmneziaVPN key, which our page also calls the robust import path:
    // its QR is dense enough to be unreliable on screen.
    case 'awg-vpn': {
      const nodes = handouts.awgNodes.filter((n) => n.vpnKey);
      if (nodes.length === 0) return [];
      const many = nodes.length > 1;
      const v3 = nodes.some((n) => n.awg3)
        ? t(` ${L.en.awg3Client}`, ` ${L.ru.awg3Client}`)
        : t('', '');
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Paste the connection key', 'Вставьте ключ подключения'),
          description: t(
            `Copy the key, open ${app.name} and add a connection from a key.${many ? ' One key per server and device.' : ''}${v3.en}`,
            `Скопируйте ключ, откройте ${app.name} и добавьте подключение из ключа.${many ? ' По ключу на сервер и устройство.' : ''}${v3.ru}`,
          ),
          buttons: nodes.map((n) => ({
            type: 'copyButton' as const,
            link: n.vpnKey!,
            text: tunnelText('Copy the key', 'Скопировать ключ', awgLabel(n), many),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }

    // A wg-quick .conf per tunnel, and our page for the QR of each: the shop
    // draws no QR of its own that a WireGuard client could read.
    case 'awg-conf':
    case 'download': {
      const nodes = handouts.awgNodes.filter((n) => n.conf);
      if (nodes.length === 0) return [];
      const many = nodes.length > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Download the config', 'Скачайте конфигурацию'),
          description: t(
            `Download the .conf file and import it into ${app.name}.${many ? ' One file per server and device.' : ''}`,
            `Скачайте файл .conf и импортируйте его в ${app.name}.${many ? ' По файлу на сервер и устройство.' : ''}`,
          ),
          buttons: nodes.map((n) => ({
            type: 'external' as const,
            link: withQuery(subUrl, `format=wgconf&${awgQuery(n)}`),
            text: tunnelText('AmneziaWG (.conf)', 'AmneziaWG (.conf)', awgLabel(n), many),
            svgIconKey: 'DownloadIcon',
          })),
        },
        {
          svgIconKey: 'ExternalLink',
          svgIconColor: 'sky',
          title: t('Or scan a QR code', 'Или отсканируйте QR-код'),
          description: t(
            `Your subscription page shows a QR code for every tunnel: scan it with ${app.name} and skip the file.`,
            `На странице вашей подписки есть QR-код каждого туннеля: отсканируйте его в ${app.name}, и файл не понадобится.`,
          ),
          buttons: [
            { type: 'external', link: subUrl, text: t('Open the subscription page', 'Открыть страницу подписки'), svgIconKey: 'ExternalLink' },
          ],
        },
      ];
    }

    // An Outline key carries one server, so one key per node.
    case 'outline': {
      const nodes = handouts.outlineNodes;
      if (nodes.length === 0) return [];
      const many = nodes.length > 1;
      return [
        {
          svgIconKey: 'DownloadIcon',
          svgIconColor: 'emerald',
          title: t('Paste the access key', 'Вставьте ключ доступа'),
          description: t(
            `Copy the key and add it in ${app.name}.${many ? ' One key per server.' : ''}`,
            `Скопируйте ключ и добавьте его в ${app.name}.${many ? ' По ключу на сервер.' : ''}`,
          ),
          buttons: nodes.map((n) => ({
            type: 'copyButton' as const,
            link: n.key,
            text: tunnelText('Copy the key', 'Скопировать ключ', n.nodeName, many),
            svgIconKey: 'Plus',
          })),
        },
      ];
    }
  }
}

/** A tg://socks link as Telegram's own https form: the shop opens https links
 *  in a browser, which hands them to the app. */
function tmeSocks(tgUri: string): string {
  return tgUri.replace(/^tg:\/\/socks\?/, 'https://t.me/socks?');
}

/**
 * Telegram as an app: our page draws it as its own row whenever the
 * subscription carries MTProto, and hands out a link per MTProto node and per
 * SOCKS endpoint. Nothing to install and nothing to import, so the card is the
 * links. HTTP proxies have no link in any Telegram client and stay on our page.
 */
function telegramApp(platform: PlatformId, handouts: SubpageConfigInput['handouts']): SubpageApp | null {
  if (!TELEGRAM_PLATFORMS.includes(platform)) return null;
  const mt = handouts.protocols.includes('mtproto') ? handouts.mtprotoNodes.filter((n) => n.tmeUri) : [];
  const socks = handouts.telegramProxies.filter((p) => p.kind === 'socks' && p.tgUri);
  const links = [
    ...mt.map((n) => ({ label: n.nodeName, link: n.tmeUri })),
    ...socks.map((p) => ({ label: `${p.nodeName} (SOCKS5)`, link: tmeSocks(p.tgUri!) })),
  ];
  if (links.length === 0) return null;
  const many = links.length > 1;
  return {
    name: 'Telegram',
    featured: false,
    blocks: [
      {
        svgIconKey: 'ShieldPlus',
        svgIconColor: 'sky',
        title: t('Connect the proxy', 'Подключите прокси'),
        description: t(
          'Tap the button: Telegram offers to connect to the proxy. Nothing to install. It works for Telegram only.',
          'Нажмите кнопку: Telegram предложит подключиться к прокси. Устанавливать ничего не нужно. Работает только для Telegram.',
        ),
        buttons: links.map((l) => ({
          type: 'external' as const,
          link: l.link,
          text: tunnelText('Connect', 'Подключить', l.label, many),
          svgIconKey: 'Plus',
        })),
      },
    ],
  };
}

/**
 * The v1 document, or null when no platform has an app to offer (the shop then
 * falls back to its own, as it did for `{}`).
 */
export function buildSubpageConfig(input: SubpageConfigInput): SubpageConfig | null {
  const { handouts } = input;
  const hasAwg = handouts.awgNodes.length > 0;
  const hasOutline = handouts.outlineNodes.length > 0;
  const platforms: SubpageConfig['platforms'] = {};

  for (const ours of PLATFORM_ORDER) {
    const shopKey = PLATFORM_TO_SHOP[ours];
    if (!shopKey) continue;
    const apps: SubpageApp[] = [];
    for (const app of appsFor(ours, handouts.protocols as ProtocolName[], hasAwg, hasOutline)) {
      const steps = importBlocks(app, input);
      if (steps.length === 0) continue;
      const install = installBlock(app);
      apps.push({ name: app.name, featured: !!app.recommended, blocks: install ? [install, ...steps] : steps });
    }
    const tg = telegramApp(ours, handouts);
    if (tg) apps.push(tg);
    if (apps.length === 0) continue;
    platforms[shopKey] = { displayName: PLATFORM_DISPLAY[shopKey]!, svgIconKey: PLATFORM_ICON_KEY[shopKey]!, apps };
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
