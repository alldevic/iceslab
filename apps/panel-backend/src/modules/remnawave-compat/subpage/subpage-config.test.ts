import { describe, expect, it } from 'vitest';
import { buildSubpageConfig, SUBSCRIPTION_LINK_PLACEHOLDER, type SubpageConfig, type SubpageConfigInput } from './subpage-config.js';
import { SVG_LIBRARY } from './chrome.js';

const SUB = 'https://sub.example.com/sub/tok123';
const branding = { title: 'Test', logoUrl: 'https://sub.example.com', supportUrl: 'https://sub.example.com' };

function input(h: Partial<SubpageConfigInput['handouts']>, subUrl = SUB): SubpageConfigInput {
  return {
    subUrl,
    branding,
    handouts: { protocols: [], awgNodes: [], mtprotoNodes: [], telegramProxies: [], outlineNodes: [], ...h },
  };
}

function app(doc: SubpageConfig | null, platform: string, name: string) {
  return doc?.platforms[platform]?.apps.find((a) => a.name === name);
}

function buttons(doc: SubpageConfig | null, platform: string, name: string) {
  return (app(doc, platform, name)?.blocks ?? []).flatMap((b) => b.buttons);
}

describe('the install document of the compatibility API', () => {
  it('is null when the subscription has nothing an app is offered for', () => {
    expect(buildSubpageConfig(input({}))).toBeNull();
  });

  it('offers the page\'s apps for a proxy subscription, with the person\'s link in the deep link', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray'] }));
    expect(doc?.version).toBe('1');
    expect(Object.keys(doc!.platforms)).toEqual(['ios', 'android', 'windows', 'macos', 'linux', 'androidTV', 'appleTV']);
    const happ = app(doc, 'ios', 'Happ');
    expect(happ?.featured).toBe(true);
    // Install first, import second: the order a person does it in.
    expect(happ?.blocks.map((b) => b.title.en)).toEqual(['Install the app', 'Add the subscription']);
    expect(buttons(doc, 'ios', 'Happ').map((b) => [b.type, b.link])).toEqual([
      ['external', 'https://happ.su'],
      ['subscriptionLink', `happ://add/${SUB}`],
    ]);
    // An AmneziaWG client is no answer to a proxy subscription.
    expect(app(doc, 'android', 'AmneziaVPN')).toBeUndefined();
  });

  it('a router-only app has no place in it: the shop knows no router platform', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray', 'amneziawg'] }));
    const names = Object.values(doc!.platforms).flatMap((p) => p.apps.map((a) => a.name));
    expect(names).not.toContain('Keenetic');
    expect(names).not.toContain('OpenWrt');
  });

  it('hands an AmneziaWG subscription a key per tunnel and a file per tunnel, by node and device', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['amneziawg'],
        awgNodes: [
          { nodeName: 'de-1', id: 'ep-de', device: 1, conf: '[Interface]', vpnKey: 'vpn://one' },
          { nodeName: 'de-1', id: 'ep-de', device: 2, conf: '[Interface]', vpnKey: 'vpn://two', awg3: true },
        ],
      }),
    );
    const keys = buttons(doc, 'android', 'AmneziaVPN').filter((b) => b.type === 'copyButton');
    expect(keys.map((b) => [b.link, b.text.en])).toEqual([
      ['vpn://one', 'Copy the key · de-1'],
      ['vpn://two', 'Copy the key · de-1 #2'],
    ]);
    const key = app(doc, 'android', 'AmneziaVPN')!.blocks.find((b) => b.title.en === 'Paste the connection key')!;
    expect(key.description.en).toContain('AmneziaWG 3.1');
    const files = buttons(doc, 'android', 'AmneziaWG').filter((b) => b.text.en.startsWith('AmneziaWG (.conf)'));
    expect(files.map((b) => b.link)).toEqual([`${SUB}?format=wgconf&node=ep-de`, `${SUB}?format=wgconf&node=ep-de&device=2`]);
    // The shop draws no QR a WireGuard client can read; our page does.
    expect(buttons(doc, 'android', 'AmneziaWG').some((b) => b.link === SUB && b.type === 'external')).toBe(true);
  });

  it('a tunnel app without a tunnel behind it is left out, not drawn empty', () => {
    const doc = buildSubpageConfig(input({ protocols: ['amneziawg', 'xray'], awgNodes: [] }));
    expect(app(doc, 'android', 'AmneziaVPN')).toBeUndefined();
    expect(app(doc, 'android', 'AmneziaWG')).toBeUndefined();
  });

  it('Telegram gets a link per MTProto node and per SOCKS endpoint, in the https form', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['mtproto', 'xray'],
        mtprotoNodes: [{ nodeName: 'nl-1', uri: 'tg://proxy?server=a', tmeUri: 'https://t.me/proxy?server=a' }],
        telegramProxies: [
          { nodeName: 'nl-2', kind: 'socks', tgUri: 'tg://socks?server=b&port=1080', host: 'b', port: 1080, username: 'u', password: 'p' },
          { nodeName: 'nl-3', kind: 'http', host: 'c', port: 8080, username: 'u', password: 'p' },
        ],
      }),
    );
    expect(buttons(doc, 'ios', 'Telegram').map((b) => b.link)).toEqual([
      'https://t.me/proxy?server=a',
      'https://t.me/socks?server=b&port=1080',
    ]);
    // No Telegram on a television.
    expect(app(doc, 'androidTV', 'Telegram')).toBeUndefined();
  });

  it('an Outline key per Shadowsocks node', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['shadowsocks'], outlineNodes: [{ nodeName: 'fi-1', key: 'ssconf://sub.example.com/x#fi-1' }] }),
    );
    expect(buttons(doc, 'windows', 'Outline').filter((b) => b.type === 'copyButton').map((b) => b.link)).toEqual([
      'ssconf://sub.example.com/x#fi-1',
    ]);
  });

  // The shared document has no person. The shop substitutes its placeholder
  // as text, so it survives only in a link that carries the URL as it is.
  it('the shared document uses the shop\'s placeholder, and copies where a deep link would encode it', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray'] }, SUBSCRIPTION_LINK_PLACEHOLDER));
    expect(buttons(doc, 'android', 'Happ').find((b) => b.type === 'subscriptionLink')?.link).toBe(`happ://add/${SUBSCRIPTION_LINK_PLACEHOLDER}`);
    const v2rayng = buttons(doc, 'android', 'v2rayNG');
    expect(v2rayng.find((b) => b.type === 'subscriptionLink')).toBeUndefined();
    expect(v2rayng.find((b) => b.type === 'copyButton')?.link).toBe(SUBSCRIPTION_LINK_PLACEHOLDER);
  });

  it('every icon it names is in the library, every localized string has both locales', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'amneziawg', 'mtproto', 'shadowsocks'],
        awgNodes: [{ nodeName: 'a', id: 'a', device: 1, conf: 'c', vpnKey: 'vpn://k' }],
        mtprotoNodes: [{ nodeName: 'm', uri: 'tg://x', tmeUri: 'https://t.me/x' }],
        outlineNodes: [{ nodeName: 's', key: 'ssconf://k' }],
      }),
    )!;
    for (const p of Object.values(doc.platforms)) {
      expect(SVG_LIBRARY[p.svgIconKey], p.svgIconKey).toBeDefined();
      expect(p.apps.length).toBeGreaterThan(0);
      for (const a of p.apps) {
        expect(a.blocks.length, a.name).toBeGreaterThan(0);
        for (const b of a.blocks) {
          expect(SVG_LIBRARY[b.svgIconKey], b.svgIconKey).toBeDefined();
          for (const s of [b.title, b.description, ...b.buttons.map((x) => x.text)]) expect(Object.keys(s).sort()).toEqual(['en', 'ru']);
          for (const x of b.buttons) {
            expect(SVG_LIBRARY[x.svgIconKey], x.svgIconKey).toBeDefined();
            expect(x.link, `${a.name}: ${b.title.en}`).not.toBe('');
          }
        }
      }
    }
  });
});
