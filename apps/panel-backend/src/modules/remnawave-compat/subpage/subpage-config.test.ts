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
        const got = (doc.platforms[toShop[p] ?? p]?.apps ?? []).map((a) => a.name);
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
    // Install first: that is the order a person does it in.
    expect(amnezia.blocks[0].buttons[0].link).toBe('https://amnezia.org');
    expect(amnezia.blocks[1].buttons[0].link).toBe('vpn://K');
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
