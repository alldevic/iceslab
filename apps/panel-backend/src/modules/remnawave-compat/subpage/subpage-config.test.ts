// What the shop's install screen is allowed to promise a buyer.
//
// The constraints checked here are the shop's, read from
// `backend/config/subscription_guides_config.py` at v3.6.1 (14.6: re-check against v3.8.6 on the stand, 15.1) — a document that
// breaks one of them is REJECTED whole, and the shop silently renders its own
// generic guide instead. That failure is invisible from this side, which is
// exactly why it is worth a test.

import { describe, it, expect } from 'vitest';
import { PLATFORM_ORDER } from '../../subscription/subscription.page-apps.js';
import { appsFor } from '../../subscription/subscription.page.js';
import { buildSubpageConfig, type SubpageConfigInput } from './subpage-config.js';

const OTHER = 'Другой клиент';

const BRANDING = {
  title: 'Lab',
  logoUrl: 'https://panel.example',
  supportUrl: 'https://panel.example/support',
};

function input(over: Partial<SubpageConfigInput> = {}): SubpageConfigInput {
  return {
    subUrl: 'https://panel.example/sub/tok',
    protocols: ['xray'],
    awgNodes: [],
    wgNodes: [],
    mtprotoNodes: [],
    branding: BRANDING,
    ...over,
  };
}

/** Every app in the document, as `platform → [app names]`. */
function appNames(doc: NonNullable<ReturnType<typeof buildSubpageConfig>>) {
  return Object.fromEntries(
    Object.entries(doc.platforms).map(([k, v]) => [k, v.apps.map((a) => a.name)]),
  );
}

function allButtons(doc: NonNullable<ReturnType<typeof buildSubpageConfig>>) {
  return Object.values(doc.platforms).flatMap((p) =>
    p.apps.flatMap((a) => a.blocks.flatMap((b) => b.buttons)),
  );
}

describe('buildSubpageConfig', () => {
  it('offers an AmneziaWG-only buyer only clients that can read their config', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['amneziawg'],
        // What the route passes for this buyer: only the tunnel files carry anything.
        usableFormats: ['wgconf', 'amneziavpn'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://KEY' }],
      }),
    );
    const names = new Set(Object.values(appNames(doc!)).flat());

    expect(names).toContain('AmneziaVPN');
    expect(names).toContain('AmneziaWG');
    // The shop's own default guide offers these three to everyone. For this
    // buyer they are three clients that cannot read an AmneziaWG tunnel.
    expect(names).not.toContain('sing-box');
    expect(names).not.toContain('v2rayNG');
    expect(names).not.toContain('Streisand');
    // Hiddify DOES speak AmneziaWG, but the catalogue offers it as a
    // subscription deep link, and this buyer's subscription is empty (measured:
    // 0 bytes from ?format=plain). A working client pointed at nothing.
    expect(names).not.toContain('Hiddify');
  });

  it('hands the AmneziaWG buyer a key to copy and a file to download, never a QR', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://KEY' }] }),
    )!;
    const buttons = allButtons(doc);

    // `installGuideRuntime.ts` copies a copyButton and opens everything else;
    // there is no per-button QR on that screen, so the key has to be copyable.
    const copy = buttons.filter((b) => b.type === 'copyButton');
    expect(copy.map((b) => b.link)).toContain('vpn://KEY');

    const files = buttons.filter((b) => b.link.includes('format=wgconf'));
    expect(files.length).toBeGreaterThan(0);
    for (const b of files) {
      // An AmneziaWG file is the unmarked kind; `protocols=` is for plain WireGuard.
      expect(b.link).not.toContain('protocols=');
      expect(b.link).toContain('node=nl-1');
    }
  });

  it('labels tunnel buttons by node only when there is more than one node', () => {
    const one = buildSubpageConfig(
      input({ protocols: ['wireguard'], wgNodes: [{ nodeName: 'nl-1' }] }),
    )!;
    expect(allButtons(one).every((b) => !b.text.ru.includes('nl-1'))).toBe(true);

    const two = buildSubpageConfig(
      input({ protocols: ['wireguard'], wgNodes: [{ nodeName: 'nl-1' }, { nodeName: 'de-2' }] }),
    )!;
    const labels = allButtons(two).map((b) => b.text.ru);
    expect(labels.some((l) => l.includes('nl-1'))).toBe(true);
    expect(labels.some((l) => l.includes('de-2'))).toBe(true);
  });

  it('names a tunnel by its id and device, and marks plain WireGuard files', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['wireguard'],
        wgNodes: [{ nodeName: 'nl-1', id: 'ep-9', device: 2 }],
      }),
    )!;
    const files = allButtons(doc).filter((b) => b.link.includes('format=wgconf'));
    expect(files.length).toBeGreaterThan(0);
    for (const b of files) {
      expect(b.link).toBe('https://panel.example/sub/tok?protocols=wireguard&format=wgconf&node=ep-9&device=2');
    }
  });

  it('offers the same apps as the subscription page for the same protocols', () => {
    const cases: Array<Partial<SubpageConfigInput>> = [
      { protocols: ['xray', 'shadowsocks', 'hysteria'] },
      { protocols: ['xray', 'tuic', 'anytls', 'shadowtls'] },
      { protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] },
      { protocols: ['wireguard'], wgNodes: [{ nodeName: 'nl-1' }] },
      {
        protocols: ['xray', 'amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2' }],
      },
    ];
    const toShop: Record<string, string> = { androidtv: 'androidTV', appletv: 'appleTV' };
    for (const c of cases) {
      const i = input(c);
      const doc = buildSubpageConfig(i)!;
      const hasAwg = i.awgNodes.length > 0 || i.wgNodes.length > 0;
      for (const p of PLATFORM_ORDER) {
        if (p === 'router') {
          expect(doc.platforms['router']).toBeUndefined();
          continue;
        }
        const expected = appsFor(p, [...i.protocols], hasAwg, false).map((a) => a.name);
        // The "other client" card stands last on every tab and is not an app of the catalogue.
        const got = (doc.platforms[toShop[p] ?? p]?.apps ?? []).map((a) => a.name).filter((n) => n !== OTHER);
        expect(got, `${p} for ${i.protocols.join(',')}`).toEqual(expected);
      }
    }
  });

  it('narrows the apps by usable formats, as the page does', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray'], usableFormats: ['xrayjson', 'plain'] }))!;
    const names = new Set(Object.values(appNames(doc)).flat());
    expect(names).not.toContain('sing-box');
    expect(names).toContain('v2rayNG');
  });

  it('hands an Outline key to copy when there is one, and no Outline card otherwise', () => {
    const withKey = buildSubpageConfig(
      input({ protocols: ['shadowsocks'], outlineNodes: [{ nodeName: 'nl-1', key: 'ssconf://x/k' }] }),
    )!;
    const outline = Object.values(withKey.platforms).flatMap((p) => p.apps).find((a) => a.name === 'Outline')!;
    expect(outline.blocks.at(-1)!.buttons[0]).toMatchObject({ type: 'copyButton', link: 'ssconf://x/k' });
    const without = buildSubpageConfig(input({ protocols: ['shadowsocks'] }))!;
    expect(new Set(Object.values(appNames(without)).flat())).not.toContain('Outline');
  });

  it('gives a proxy buyer no tunnel downloads', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray', 'shadowsocks'] }))!;
    expect(allButtons(doc).some((b) => b.link.includes('format=wgconf'))).toBe(false);
    const names = new Set(Object.values(appNames(doc)).flat());
    expect(names).not.toContain('AmneziaVPN');
    expect(names).not.toContain('WireGuard');
  });

  it('drops an AmneziaWG app when the protocol is there but no node produced a file', () => {
    // Reachable: a host switched off for `wgconf` leaves the protocol present
    // and the node list empty. A card linking to an empty download is worse
    // than no card.
    const doc = buildSubpageConfig(input({ protocols: ['amneziawg'], awgNodes: [], usableFormats: [] }));
    expect(doc).toBeNull();
  });

  it('omits a platform rather than emitting it empty', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    // The shop rejects the WHOLE document on `apps must be a non-empty array`,
    // so an empty platform is not a cosmetic flaw.
    for (const p of Object.values(doc.platforms)) expect(p.apps.length).toBeGreaterThan(0);
    // No AmneziaWG client is listed for Apple TV, so the tab must be absent.
    expect(doc.platforms.appleTV).toBeUndefined();
    // `router` is not in the shop's ALLOWED_PLATFORMS at all; emitting it is an
    // "Unsupported platform" rejection.
    expect(doc.platforms.router).toBeUndefined();
  });

  it('never references an svgIconKey the library does not carry', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'shadowsocks', 'hysteria', 'amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2' }],
      }),
    )!;
    const library = new Set(Object.keys(doc.svgLibrary));
    const referenced: string[] = [];
    for (const p of Object.values(doc.platforms)) {
      referenced.push(p.svgIconKey);
      for (const a of p.apps) {
        if (a.svgIconKey) referenced.push(a.svgIconKey);
        for (const b of a.blocks) {
          referenced.push(b.svgIconKey);
          for (const btn of b.buttons) referenced.push(btn.svgIconKey);
        }
      }
    }
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((k) => !library.has(k))).toEqual([]);
  });

  it('carries every declared locale on every localized string', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'amneziawg'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }],
      }),
    )!;
    const missing: string[] = [];
    const check = (path: string, v: Record<string, string>) => {
      for (const loc of doc.locales) {
        if (typeof v?.[loc] !== 'string' || !v[loc].trim()) missing.push(`${path}.${loc}`);
      }
    };
    for (const [pk, p] of Object.entries(doc.platforms)) {
      for (const a of p.apps) {
        for (const [bi, b] of a.blocks.entries()) {
          check(`${pk}.${a.name}.blocks[${bi}].title`, b.title);
          check(`${pk}.${a.name}.blocks[${bi}].description`, b.description);
          for (const [ci, btn] of b.buttons.entries()) {
            check(`${pk}.${a.name}.blocks[${bi}].buttons[${ci}].text`, btn.text);
          }
        }
      }
    }
    // Same rule on the vendored chrome: BASE_TRANSLATION_KEYS are all required.
    for (const [k, v] of Object.entries(doc.baseTranslations)) check(`baseTranslations.${k}`, v);
    expect(missing).toEqual([]);
  });

  it('gives an mtproto buyer the one thing Telegram takes: the t.me link', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['mtproto'],
        mtprotoNodes: [{ nodeName: 'nl-1', tmeUri: 'https://t.me/proxy?server=a&port=1&secret=ee' }],
      }),
    )!;
    const names = new Set(Object.values(appNames(doc)).flat());
    expect(names).toEqual(new Set(['Telegram']));

    const buttons = allButtons(doc);
    expect(buttons).toHaveLength(5); // ios, android, windows, macos, linux
    for (const b of buttons) {
      // `external`, not `copyButton`: the shop OPENS anything that is not a
      // copyButton, and an opened t.me link is what Telegram turns into a
      // "connect to this proxy" prompt.
      expect(b.type).toBe('external');
      expect(b.link).toBe('https://t.me/proxy?server=a&port=1&secret=ee');
    }
    // Nothing points at our subscription: no proxy client reads mtproto out of
    // it, and Telegram would make nothing of the URL.
    expect(buttons.some((b) => b.link.includes('/sub/'))).toBe(false);
  });

  it('offers an install link only where the catalogue names a page, and install before import', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    const amnezia = doc.platforms.ios.apps.find((a) => a.name === 'AmneziaVPN')!;
    // Install first, then the import: that is the order a person does it in.
    // (AmneziaVPN is not in the Russian storefront on iOS, so its card also
    // opens with the notice and "what you get"; see the order test below.)
    const install = amnezia.blocks.findIndex((b) => b.title.en === 'Install the app');
    const key = amnezia.blocks.findIndex((b) => b.buttons[0]?.link === 'vpn://K');
    expect(amnezia.blocks[install].buttons[0].link).toBe('https://amnezia.org');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(key).toBeGreaterThan(install);
  });

  it('never links an app to a page the catalogue does not name', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'shadowsocks', 'hysteria', 'amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2' }],
      }),
    )!;
    // The shop's own guide points sing-box at App Store id 6673731168, which
    // answers 404; inheriting that link would send buyers nowhere.
    expect(allButtons(doc).filter((b) => b.link.includes('6673731168'))).toEqual([]);
  });

  it('returns null when there is nothing to say, so the shop keeps its own guide', () => {
    expect(buildSubpageConfig(input({ protocols: [] }))).toBeNull();
    // The protocol is there but no endpoint produced a link — nothing to offer.
    expect(buildSubpageConfig(input({ protocols: ['mtproto'], mtprotoNodes: [] }))).toBeNull();
  });
});

// ─── 14.7: the shop's cards ────────────────────────────────────────────────

type Doc = NonNullable<ReturnType<typeof buildSubpageConfig>>;

function appOn(doc: Doc, platform: string, name: string) {
  return doc.platforms[platform]?.apps.find((a) => a.name === name);
}

const titles = (a: { blocks: Array<{ title: Record<string, string> }> } | undefined) =>
  (a?.blocks ?? []).map((b) => b.title.en);

const SUB = 'https://panel.example/sub/tok';

describe('tunnel cards: files and the QR', () => {
  it('gives a .conf card a QR link to its own tunnel, with the #scan anchor', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', id: 'a1b2c3d4', device: 1, vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2', id: 'e5f6a7b8', device: 2 }],
      }),
    )!;
    const card = appOn(doc, 'android', 'WireGuard')!;
    const qr = card.blocks.find((b) => b.title.en === 'Or scan a QR code')!;
    // The page's preselect link (13.2): `node=` (+ `device=` from the second), no `format=`.
    expect(qr.buttons.map((b) => b.link)).toEqual([`${SUB}?node=e5f6a7b8&device=2#scan`]);
    const file = card.blocks.find((b) => b.title.en === 'Download the config')!;
    expect(file.buttons.map((b) => b.link)).toEqual([
      `${SUB}?protocols=wireguard&format=wgconf&node=e5f6a7b8&device=2`,
    ]);
  });

  it('names the tunnel by endpoint id for AmneziaWG too, and keeps the key card QR-free', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['amneziawg'],
        awgNodes: [{ nodeName: 'nl-1', id: 'a1b2c3d4', vpnKey: 'vpn://K' }],
      }),
    )!;
    const conf = appOn(doc, 'android', 'AmneziaWG')!;
    const qr = conf.blocks.find((b) => b.title.en === 'Or scan a QR code')!;
    expect(qr.buttons[0].link).toBe(`${SUB}?node=a1b2c3d4#scan`);
    // The AmneziaVPN card copies a key: no per-button QR exists in the shop.
    expect(titles(appOn(doc, 'ios', 'AmneziaVPN'))).not.toContain('Or scan a QR code');
  });

  it('gives a subscription client no QR block', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray'] }))!;
    expect(
      Object.values(doc.platforms).some((p) => p.apps.some((a) => titles(a).includes('Or scan a QR code'))),
    ).toBe(false);
  });
});

describe('"What you get"', () => {
  it('stands before the install and import steps on every app card', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', id: 'a1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2', id: 'b2' }],
      }),
    )!;
    for (const [k, p] of Object.entries(doc.platforms)) {
      for (const a of p.apps.filter((x) => x.name !== OTHER)) {
        const t = titles(a);
        const gives = t.indexOf('What you get');
        expect(gives, `${k}/${a.name}`).toBeGreaterThanOrEqual(0);
        for (const step of ['Install the app', 'Add the subscription', 'Download the config', 'Paste the connection key']) {
          if (t.includes(step)) expect(gives, `${k}/${a.name}/${step}`).toBeLessThan(t.indexOf(step));
        }
      }
    }
  });

  it('names the channels the format carries and no others', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray', 'tuic', 'shadowtls', 'amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }))!;
    const text = (name: string, platform: string) =>
      appOn(doc, platform, name)!.blocks.find((b) => b.title.en === 'What you get')!.description.en;
    // Happ's format (plain) is a link list: no ShadowTLS (no share link), no tunnel.
    const happ = text('Happ', 'ios');
    expect(happ).toContain('VLESS');
    expect(happ).toContain('TUIC');
    expect(happ).not.toContain('ShadowTLS');
    expect(happ).not.toContain('AmneziaWG');
    expect(happ).toContain('no routing rules');
    // sing-box reads ShadowTLS from the whole config, and the rules arrive with it.
    const sb = text('sing-box', 'android');
    expect(sb).toContain('ShadowTLS');
    expect(sb).toContain('arrive with the config');
  });

  it('does not credit Hiddify with the AmneziaWG its subscription format cannot carry', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['xray', 'amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    const d = appOn(doc, 'android', 'Hiddify')!.blocks.find((b) => b.title.en === 'What you get')!;
    expect(d.description.en).toContain('VLESS');
    expect(d.description.en).not.toContain('AmneziaWG');
  });

  it('names the tunnels a tunnel app gets', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['amneziawg'],
        awgNodes: [{ nodeName: 'nl-1', id: 'a1' }, { nodeName: 'de-2', id: 'b2' }],
      }),
    )!;
    const d = appOn(doc, 'android', 'AmneziaWG')!.blocks.find((b) => b.title.en === 'What you get')!;
    expect(d.description.en).toContain('AmneziaWG (nl-1, de-2)');
  });

  it('warns that a second tunnel can knock MTProto out', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['mtproto'], mtprotoNodes: [{ nodeName: 'nl-1', tmeUri: 'https://t.me/proxy?x=1' }] }),
    )!;
    const d = appOn(doc, 'ios', 'Telegram')!.blocks[0];
    expect(d.title.en).toBe('What you get');
    expect(d.description.en).toContain('leave one of the two switched on');
  });
});

describe('an app the store does not give this buyer', () => {
  const doc = buildSubpageConfig(input({ protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls'] }))!;

  it('says so above the install step, with alternatives from the same tab', () => {
    const happ = appOn(doc, 'ios', 'Happ')!;
    const t = titles(happ);
    expect(t[0]).toBe('Not in the Russian App Store');
    expect(t.indexOf('Install the app')).toBeGreaterThan(0);
    const note = happ.blocks[0].description;
    // Free, gettable on the iOS tab, without a gap of their own.
    expect(note.en).toContain('Karing');
    expect(note.en).not.toContain('Shadowrocket');
    expect(note.en).not.toContain('V2Box');
    expect(note.ru).toContain('ставятся без этого ограничения');
    // Similar-named apps are another publisher's.
    expect(note.en).toContain('similar names');
  });

  it('tells a delisted app (sing-box on iOS) from a storefront gap', () => {
    const sb = appOn(doc, 'ios', 'sing-box')!;
    expect(sb.blocks[0].title.en).toBe('Not in the App Store right now');
    expect(appOn(doc, 'macos', 'sing-box')!.blocks[0].title.en).not.toMatch(/App Store/);
  });

  it('marks the gap per platform, not per app', () => {
    expect(titles(appOn(doc, 'android', 'Happ'))).not.toContain('Not in the Russian App Store');
    expect(titles(appOn(doc, 'windows', 'Hiddify'))[0]).toBe('What you get');
  });

  it('never says "from the store" about an alternative that does not come from it', () => {
    for (const p of Object.values(doc.platforms)) {
      for (const a of p.apps) {
        for (const b of a.blocks.filter((x) => x.title.en.startsWith('Not in'))) {
          expect(b.description.en).not.toMatch(/from the store|from the App Store/);
          expect(b.description.ru).not.toMatch(/из магазина/);
        }
      }
    }
  });

  it('leaves a notice off the free, available apps', () => {
    const t = titles(appOn(doc, 'ios', 'Karing'));
    expect(t).not.toContain('A paid app');
    expect(t.some((x) => x.startsWith('Not in'))).toBe(false);
    expect(titles(appOn(doc, 'ios', 'INCY')).some((x) => x.startsWith('Not in'))).toBe(false);
  });

  it('names the price of a paid app with its measurement date, and offers only free alternatives', () => {
    const rocket = appOn(doc, 'ios', 'Shadowrocket')!;
    expect(rocket.blocks[0].title.en).toBe('A paid app');
    expect(rocket.blocks[0].description.en).toContain('249 ₽ as measured on 2026-09-16');
    expect(rocket.blocks[0].description.ru).toContain('249 ₽ по замеру на 16.09.2026');
    expect(rocket.blocks[0].description.en).toContain('free');
    expect(rocket.blocks[0].description.en).not.toContain('Shadowrocket is free');
    // The same listing on the Apple TV tab.
    expect(titles(appOn(doc, 'appleTV', 'Shadowrocket'))[0]).toBe('A paid app');
    // Never offered as a way out of the missing listing.
    expect(appOn(doc, 'ios', 'Streisand')!.blocks[0].description.en).not.toContain('Shadowrocket');
  });

  it('agrees in number with the list it names', () => {
    const one = appOn(doc, 'appleTV', 'Shadowrocket')!.blocks[0].description;
    const many = appOn(doc, 'ios', 'Shadowrocket')!.blocks[0].description;
    expect(many.en).toMatch(/ are free and work /);
    expect(many.ru).toContain('ставятся бесплатно и работают');
    // Either way somebody is named, so the note never ends in a bare price.
    expect(one.en).toMatch(/On this tab .+ (is|are) free/);
  });

  it('keeps the AmneziaWG buyer off subscription clients', () => {
    const awg = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    const vpn = appOn(awg, 'ios', 'AmneziaVPN')!;
    expect(vpn.blocks[0].title.en).toBe('Not in the Russian App Store');
    // DefaultVPN is the one tunnel client of the iOS tab that the store carries.
    expect(vpn.blocks[0].description.en).toContain('DefaultVPN');
    expect(vpn.blocks[0].description.en).not.toMatch(/Happ|Karing|Streisand|sing-box/);
  });

  it('does not claim a store for V2Box on the iPhone and offers it nowhere else', () => {
    const v2 = appOn(doc, 'ios', 'V2Box')!;
    expect(v2.blocks[0].title.en).toBe('Not in the Russian App Store');
    expect(v2.blocks[0].description.en).toContain('similar names');
    const where = Object.entries(doc.platforms).filter(([, p]) => p.apps.some((a) => a.name === 'V2Box'));
    expect(where.map(([k]) => k)).toEqual(['ios']);
  });
});

describe('Karing', () => {
  it('is offered on a xray buyer\'s desktop and phone tabs, with routing rules arriving', () => {
    const doc = buildSubpageConfig(input({ protocols: ['xray'] }))!;
    for (const p of ['ios', 'android', 'windows', 'macos', 'linux']) {
      expect(appOn(doc, p, 'Karing'), p).toBeDefined();
    }
    const gives = appOn(doc, 'android', 'Karing')!.blocks.find((b) => b.title.en === 'What you get')!;
    expect(gives.description.en).not.toContain('no routing rules');
    // Karing's import is by link (13.1: no deeplink until a real client confirms it).
    const add = appOn(doc, 'android', 'Karing')!.blocks.find((b) => b.title.en === 'Add the subscription')!;
    expect(add.buttons[0]).toMatchObject({ type: 'copyButton', link: SUB });
  });
});

describe('the "other client" card', () => {
  const full = () =>
    buildSubpageConfig(
      input({
        protocols: ['xray', 'tuic', 'shadowtls', 'amneziawg', 'wireguard', 'mtproto'],
        awgNodes: [{ nodeName: 'nl-1', id: 'a1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2', id: 'b2' }],
        mtprotoNodes: [{ nodeName: 'nl-1', tmeUri: 'https://t.me/proxy?x=1' }],
      }),
    )!;

  it('stands last on every tab that has an app', () => {
    for (const p of Object.values(full().platforms)) {
      expect(p.apps.at(-1)!.name).toBe(OTHER);
      expect(p.apps.filter((a) => a.name === OTHER)).toHaveLength(1);
    }
  });

  it('has one block per channel the buyer holds and no "what you get"', () => {
    const card = appOn(full(), 'android', OTHER)!;
    const t = titles(card);
    expect(t).not.toContain('What you get');
    expect(t).toEqual(
      expect.arrayContaining(['VLESS', 'TUIC', 'ShadowTLS', 'Add the subscription', 'Tunnel files', 'Telegram proxy']),
    );
    // Not a protocol the buyer does not hold.
    expect(t).not.toContain('Hysteria2');
    expect(t).not.toContain('Shadowsocks');
    const link = card.blocks.find((b) => b.title.en === 'Add the subscription')!;
    expect(link.buttons[0]).toMatchObject({ type: 'copyButton', link: SUB });
    const files = card.blocks.find((b) => b.title.en === 'Tunnel files')!;
    expect(files.buttons.map((b) => b.link)).toEqual([
      `${SUB}?format=wgconf&node=a1`,
      `${SUB}?protocols=wireguard&format=wgconf&node=b2`,
    ]);
    // Says out loud that a client may show only some of the lines.
    expect(card.blocks[0].description.en).toContain('only some of the lines');
  });

  it('gives a tunnel-only buyer no subscription-link block', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    const t = titles(appOn(doc, 'android', OTHER));
    expect(t).toContain('Tunnel files');
    expect(t).not.toContain('Add the subscription');
    expect(allButtons(doc).filter((b) => b.link === SUB)).toEqual([]);
  });

  it('gives a buyer with an empty link nothing to paste', () => {
    const doc = buildSubpageConfig(
      input({ subUrl: '', protocols: ['xray', 'amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    expect(titles(appOn(doc, 'android', OTHER))).not.toContain('Add the subscription');
  });

  it('is left out when no VPN channel is left, and does not make a tab of its own', () => {
    const tg = buildSubpageConfig(
      input({ protocols: ['mtproto'], mtprotoNodes: [{ nodeName: 'nl-1', tmeUri: 'https://t.me/proxy?x=1' }] }),
    )!;
    expect(Object.values(appNames(tg)).flat()).not.toContain(OTHER);
    // AmneziaWG-only has no app on Apple TV, and the card does not conjure the tab.
    const awg = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    expect(awg.platforms.appleTV).toBeUndefined();
  });

  it('carries a note for every protocol a subscription client can be handed', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['xray', 'shadowsocks', 'hysteria', 'tuic', 'anytls', 'shadowtls'] }),
    )!;
    const card = appOn(doc, 'windows', OTHER)!;
    expect(titles(card).filter((x) => x !== 'Any client will do' && x !== 'Add the subscription')).toEqual([
      'VLESS',
      'TUIC',
      'Hysteria2',
      'AnyTLS',
      'ShadowTLS',
      'Shadowsocks',
    ]);
    for (const b of card.blocks) {
      expect(b.description.en.length).toBeGreaterThan(20);
      expect(b.description.ru.length).toBeGreaterThan(20);
    }
  });
});
