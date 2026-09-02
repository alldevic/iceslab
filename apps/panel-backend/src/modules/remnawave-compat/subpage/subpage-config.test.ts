// What the shop's install screen is allowed to promise a buyer.
//
// The constraints checked here are the shop's, read from
// `backend/config/subscription_guides_config.py` at v3.6.1 — a document that
// breaks one of them is REJECTED whole, and the shop silently renders its own
// generic guide instead. That failure is invisible from this side, which is
// exactly why it is worth a test.

import { describe, it, expect } from 'vitest';
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
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://KEY' }] }),
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
      expect(b.link).toContain('proto=amneziawg');
      expect(b.link).toContain('node=nl-1');
    }
  });

  // The shop draws one QR and it is always the subscription URL, on every tab
  // including WireGuard. A wg client's scanner reads that text as the body of
  // a config: measured 2026-09-03, WG Tunnel answered "no PrivateKey" to the
  // QR shown on the page telling the buyer to set up WireGuard. The shop has
  // no per-button QR and its CSS pins any SVG we could smuggle in to 19x19, so
  // the fix is a link to the page that already draws the right QR per tunnel.
  it('offers a wg buyer the QR of their own tunnel, not just a file', () => {
    const doc = buildSubpageConfig(
      input({
        protocols: ['wireguard'],
        wgNodes: [{ nodeName: 'nl-1', deviceIndex: 1 }, { nodeName: 'nl-1', deviceIndex: 2 }],
      }),
    )!;
    const qr = allButtons(doc).filter((b) => !b.link.includes('format=') && b.link.includes('proto='));
    expect(qr.length).toBeGreaterThan(0);
    for (const b of qr) {
      // No `format=`: an explicit format is what makes the route serve a
      // config instead of the page, so a QR link carrying one lands the buyer
      // back on a downloaded file.
      expect(b.link).not.toContain('format=');
      expect(b.link).toContain('proto=wireguard');
      expect(b.link).toContain('node=nl-1');
    }
    // One per tunnel, pinned by device: a buyer with two devices scanning the
    // same QR twice puts one key on both phones.
    expect(qr.map((b) => b.link).some((l) => l.endsWith('device=1'))).toBe(true);
    expect(qr.map((b) => b.link).some((l) => l.endsWith('device=2'))).toBe(true);
  });

  it('pins the AmneziaWG QR link to the amneziawg flavour', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://KEY' }] }),
    )!;
    const qr = allButtons(doc).filter((b) => !b.link.includes('format=') && b.link.includes('proto='));
    expect(qr.length).toBeGreaterThan(0);
    // Without `proto=`, `?format=wgconf` picks the first wg endpoint whatever
    // its flavour, and a stock client handed an AmneziaWG file rejects it on
    // `Jc = 4`. The QR link must not reintroduce that ambiguity.
    for (const b of qr) expect(b.link).toContain('proto=amneziawg');
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
    const doc = buildSubpageConfig(input({ protocols: ['amneziawg'], awgNodes: [] }));
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

  it('offers an install link only where one has been checked, and install before import', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    const amnezia = doc.platforms.ios.apps.find((a) => a.name === 'AmneziaVPN')!;
    // Install first: that is the order a person does it in.
    expect(amnezia.blocks[0].buttons[0].link).toBe('https://apps.apple.com/app/id1600529900');
    expect(amnezia.blocks[1].buttons[0].link).toBe('vpn://K');

    // AmneziaWG has no checked link, so it is named and not linked — never
    // linked to a guess.
    const awgApp = doc.platforms.ios.apps.find((a) => a.name === 'AmneziaWG')!;
    expect(awgApp.blocks.map((b) => b.title.en)).not.toContain('Install the app');
    expect(awgApp.blocks[0].buttons.every((b) => b.link.includes('format=wgconf'))).toBe(true);
  });

  it('links no app anywhere to a store page that is gone', () => {
    // The shop's own guide points sing-box at App Store id 6673731168, which
    // answers 404 (checked 2026-08-26), and the official Apple client is off
    // the store entirely. Inheriting that link would send buyers nowhere — and
    // the guard has to hold for EVERY app, not just the one that tempted us:
    // the whole risk of a curated link table is a wrong entry in any row.
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'shadowsocks', 'hysteria', 'amneziawg', 'wireguard'],
        awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'de-2' }],
      }),
    )!;
    expect(allButtons(doc).filter((b) => b.link.includes('6673731168'))).toEqual([]);
    // sing-box specifically: named, and given no install block at all.
    const singbox = doc.platforms.ios.apps.find((a) => a.name === 'sing-box')!;
    expect(singbox.blocks.map((b) => b.title.en)).not.toContain('Install the app');
  });

  it('offers a mieru buyer the mihomo clients, and only those', () => {
    // The chain is ours end to end: their deep link points the app at the
    // subscription, the seeded UA rule resolves that family to the clash
    // format, and our clash builder emits `type: mieru`.
    const doc = buildSubpageConfig(input({ protocols: ['mieru'] }))!;
    const names = new Set(Object.values(appNames(doc)).flat());
    expect(names).toEqual(new Set(['Clash Verge', 'FlClash']));
    // sing-box and v2rayNG resolve to formats that carry no mieru entry.
    expect(names).not.toContain('sing-box');
    expect(names).not.toContain('v2rayNG');
  });

  it('names no client for naive, because no client in the catalogue works for it', () => {
    // clash refuses naive on purpose and sing-box has no naive outbound, so the
    // apps that could speak it resolve to a format that drops the endpoint.
    expect(buildSubpageConfig(input({ protocols: ['naive'] }))).toBeNull();
  });

  it('keeps every platform a buyer could be on covered by a maintained client', () => {
    // Nekoray was dropped as archived-upstream; this is the check that dropping
    // it took nothing away. Every platform a proxy buyer can be on still has at
    // least one client, and none of them is Nekoray.
    const doc = buildSubpageConfig(input({ protocols: ['xray', 'shadowsocks', 'hysteria'] }))!;
    for (const key of ['ios', 'android', 'windows', 'macos', 'linux']) {
      expect(doc.platforms[key]?.apps.length, `${key} has no client at all`).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(appNames(doc)).flat())).not.toContain('Nekoray');
  });

  it('does not offer a client whose format renders nothing for this fleet', () => {
    // An XHTTP-only fleet: `transport-matrix.test.ts` records sing-box as
    // `omitted` for that transport, so every sing-box-cored client hands the
    // buyer an empty config while looking like it worked.
    const usable = new Set<'plain' | 'clash' | 'xrayjson' | 'singbox'>([
      'plain',
      'clash',
      'xrayjson',
    ]);
    const doc = buildSubpageConfig(input({ protocols: ['xray'], usableFormats: usable }))!;
    const names = new Set(Object.values(appNames(doc)).flat());

    expect(names).not.toContain('sing-box');
    expect(names).not.toContain('Hiddify');
    expect(names).not.toContain('NekoBox');
    // The clients whose formats DO carry it stay, or the buyer is left with
    // nothing at all — which is the failure, not the fix.
    expect(names).toContain('Clash Verge');
    expect(names).toContain('v2rayNG');
    expect(names).toContain('Shadowrocket');
  });

  it('leaves the catalogue alone when no format check was supplied', () => {
    // A caller with no endpoints in hand must not have its list quietly
    // narrowed on a guess.
    const names = new Set(Object.values(appNames(buildSubpageConfig(input())!)).flat());
    expect(names).toContain('Hiddify');
  });

  it('returns null when there is nothing to say, so the shop keeps its own guide', () => {
    expect(buildSubpageConfig(input({ protocols: [] }))).toBeNull();
    // The protocol is there but no endpoint produced a link — nothing to offer.
    expect(buildSubpageConfig(input({ protocols: ['mtproto'], mtprotoNodes: [] }))).toBeNull();
  });

  describe('the "what you get" card', () => {
    function gives(doc: NonNullable<ReturnType<typeof buildSubpageConfig>>, platform: string, app: string) {
      const found = doc.platforms[platform]?.apps.find((a) => a.name === app);
      return found?.blocks.find((b) => b.title.en === 'What you get') ?? null;
    }

    it('names the channels this buyer holds and no others', () => {
      const doc = buildSubpageConfig(input({ protocols: ['xray', 'tuic'] }))!;
      const card = gives(doc, 'ios', 'Hiddify')!;
      expect(card.description.ru).toContain('VLESS');
      expect(card.description.ru).toContain('TUIC');
      // Hiddify speaks AnyTLS, but this buyer has no AnyTLS endpoint to speak it to.
      expect(card.description.ru).not.toContain('AnyTLS');
      expect(card.description.en).toContain('VLESS and TUIC');
    });

    it('says where the routing rules are, because a link list carries none', () => {
      const doc = buildSubpageConfig(input({ protocols: ['xray'] }))!;
      // Config formats carry our split: banks resolve directly.
      expect(gives(doc, 'ios', 'Hiddify')!.description.ru).toContain('приезжают вместе с конфигом');
      // A link list does not, and that is what a buyer whose bank refuses needs
      // to have been told BEFORE they write in.
      const plain = gives(doc, 'ios', 'Streisand')!.description.ru;
      expect(plain).toContain('банки');
      expect(plain).toContain('в самом приложении');
    });

    it('warns that a second tunnel can knock MTProto out', () => {
      const doc = buildSubpageConfig(
        input({ protocols: ['mtproto'], mtprotoNodes: [{ nodeName: 'ru-1', tmeUri: 'https://t.me/proxy?server=a' }] }),
      )!;
      const card = gives(doc, 'ios', 'Telegram')!;
      expect(card.description.ru).toContain('перестать подключаться');
      expect(card.description.en).toContain('leave one of the two');
    });

    it('points a .conf client at router instructions, and a key client at none', () => {
      const doc = buildSubpageConfig(
        input({
          protocols: ['amneziawg'],
          awgNodes: [{ nodeName: 'nl-1', deviceIndex: 1, vpnKey: 'vpn://K' }],
        }),
      )!;
      const conf = gives(doc, 'ios', 'AmneziaWG')!;
      expect(conf.buttons.map((b) => b.link)).toEqual([
        'https://docs.amnezia.org/documentation/instructions/keenetic-os-awg/',
        'https://docs.amnezia.org/documentation/instructions/openwrt-os-awg/',
      ]);
      expect(conf.description.ru).toContain('роутер');
      // AmneziaVPN imports a key, not a file: there is no file to put on a router.
      expect(gives(doc, 'ios', 'AmneziaVPN')!.buttons).toEqual([]);
    });

    it('does not tell a Happ buyer their config has no rules', () => {
      // Happ fetches `xrayjson-array`, seeded onto its UA rule so the routing
      // preset reaches it. The catalogue said `plain` for two days after that,
      // and this card repeated it to buyers as "everything goes through the
      // VPN" — the opposite of what their config does.
      const doc = buildSubpageConfig(input({ protocols: ['xray'] }))!;
      const happ = gives(doc, 'ios', 'Happ')!;
      expect(happ.description.ru).toContain('приезжают вместе с конфигом');
      expect(happ.description.ru).not.toContain('Авито');
    });

    it('offers the per-app split only on Android, where the client has it', () => {
      const doc = buildSubpageConfig(input({ protocols: ['xray'] }))!;
      expect(gives(doc, 'android', 'Hiddify')!.description.ru).toContain('выбранные приложения');
      expect(gives(doc, 'ios', 'Hiddify')!.description.ru).not.toContain('выбранные приложения');
    });
  });
});
