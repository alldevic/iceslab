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
    // same QR twice puts one key on both phones. The `#scan` fragment lands
    // them on the QR block rather than the top of the page.
    expect(qr.map((b) => b.link).some((l) => l.endsWith('device=1#scan'))).toBe(true);
    expect(qr.map((b) => b.link).some((l) => l.endsWith('device=2#scan'))).toBe(true);
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

  // WG Tunnel is the Android client this deployment already serves: the SRR
  // rule was split in two so `wgtunnel/…` gets the stock config rather than the
  // AmneziaWG one, and its User-Agent was measured fetching a correct file. The
  // catalogue said nothing about it, so the install screen offered an Android
  // WireGuard buyer only the official app - which has neither split tunnelling
  // nor auto-connect, the two reasons people install WG Tunnel.
  it('offers an Android WireGuard buyer WG Tunnel, not only the official app', () => {
    const doc = buildSubpageConfig(
      input({ protocols: ['wireguard'], wgNodes: [{ nodeName: 'nl-1' }] }),
    )!;
    const android = doc.platforms.android.apps.map((a) => a.name);
    expect(android).toContain('WG Tunnel');
    expect(android).toContain('WireGuard');
    // It reads a plain wg-quick file and nothing else: offering it to an
    // AmneziaWG-only buyer would hand them a config it rejects on `Jc = 4`.
    const awgOnly = buildSubpageConfig(
      input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
    )!;
    expect(awgOnly.platforms.android?.apps.map((a) => a.name) ?? []).not.toContain('WG Tunnel');
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

  it('sends the shop no app badges and no app icons', () => {
    // Decision 2026-09-16. Both used to be per-app decoration the catalogue
    // could not apply evenly: the vendored library has a glyph for eight of
    // our clients and nothing for the rest, so half the list was branded and
    // half was not, and the badge was a judgement the shop's card is not the
    // place for. Blocks and platforms keep their icons — those keys are
    // REQUIRED by the shop's validator, and a document missing one is rejected
    // whole rather than drawn plain.
    const doc = buildSubpageConfig(
      input({
        protocols: ['xray', 'hysteria', 'amneziawg', 'wireguard', 'mtproto'],
        awgNodes: [{ nodeName: 'n1', deviceIndex: 1, vpnKey: 'vpn://K' }],
        wgNodes: [{ nodeName: 'n1', deviceIndex: 1 }],
        mtprotoNodes: [{ nodeName: 'n1', tmeUri: 'https://t.me/proxy?server=s' }],
      }),
    )!;
    const apps = Object.values(doc.platforms).flatMap((p) => p.apps);
    expect(apps.length).toBeGreaterThan(10);
    for (const a of apps) {
      expect(a.svgIconKey, `${a.name} still carries an icon`).toBeUndefined();
      expect(a.featured, `${a.name} still carries a badge`).toBe(false);
    }
    // And the halves that stay: a platform tab and every block still name an
    // icon, because without one the document does not validate.
    for (const p of Object.values(doc.platforms)) {
      expect(p.svgIconKey).toBeTruthy();
      for (const app of p.apps) for (const b of app.blocks) expect(b.svgIconKey).toBeTruthy();
    }
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
    // By title, not by index: this assertion was written against block 0 and
    // broke the day a step was added above it, which says nothing about the
    // order it exists to pin.
    const step = (app: string, title: string, platform = 'ios') =>
      doc.platforms[platform].apps.find((a) => a.name === app)!.blocks.findIndex((b) => b.title.en === title);

    // Install before import: that is the order a person does it in.
    expect(step('AmneziaVPN', 'Install the app')).toBeGreaterThanOrEqual(0);
    expect(step('AmneziaVPN', 'Install the app')).toBeLessThan(step('AmneziaVPN', 'Paste the connection key'));
    const amnezia = doc.platforms.ios.apps.find((a) => a.name === 'AmneziaVPN')!;
    expect(amnezia.blocks.find((b) => b.title.en === 'Install the app')!.buttons[0].link).toBe(
      'https://apps.apple.com/app/id1600529900',
    );

    // Android has no checked link for AmneziaWG, so there it is named and not
    // linked — never linked to a guess.
    const awgAndroid = doc.platforms.android.apps.find((a) => a.name === 'AmneziaWG')!;
    expect(awgAndroid.blocks.map((b) => b.title.en)).not.toContain('Install the app');
    // By title again: `blocks[0]` was the download step until the "what you
    // get" card moved above it, and the assertion followed the index rather
    // than the thing it was about. Second time in this file.
    const download = awgAndroid.blocks.find((b) => b.title.en === 'Download the config')!;
    expect(download.buttons.every((b) => b.link.includes('format=wgconf'))).toBe(true);
  });

  it('orders a card the way a buyer decides: can I get it, what is it, then install', () => {
    // The "what you get" card sat last until 2026-09-05 on the reasoning that a
    // buyer who knows the client scrolls past it. The buyer this page is for is
    // choosing, and the store notice can make the whole card moot — so the two
    // that answer "is this for me" come before the two that are work.
    const doc = buildSubpageConfig(input({ protocols: ['xray', 'hysteria'] }))!;
    const happ = doc.platforms.ios.apps.find((a) => a.name === 'Happ')!;
    const at = (title: string) => happ.blocks.findIndex((b) => b.title.en === title);

    expect(at('Not in the Russian App Store')).toBe(0);
    expect(at('What you get')).toBe(1);
    expect(at('Install the app')).toBe(2);
    expect(at('Add the subscription')).toBeGreaterThan(at('Install the app'));
    // Closing the local proxy is work for after the client runs, not a reason
    // to choose it.
    expect(at('Close the local proxy')).toBeGreaterThan(at('Add the subscription'));

    // Same order where there is no notice: the description still leads.
    const wg = doc.platforms.android.apps.find((a) => a.name === 'Happ')!;
    const wAt = (t: string) => wg.blocks.findIndex((b) => b.title.en === t);
    expect(wAt('What you get')).toBe(0);
    expect(wAt('Install the app')).toBe(1);
  });

  // Measured 2026-09-05 against the Russian storefront, with a control on both
  // sides (Telegram present, Proton VPN absent). Buyers were following an
  // install button to a store page their account cannot open, and the tickets
  // that followed were about these instructions.
  describe('an app the Russian App Store does not carry', () => {
    const proxy = () => buildSubpageConfig(input({ protocols: ['xray', 'hysteria'] }))!;
    const card = (
      doc: NonNullable<ReturnType<typeof buildSubpageConfig>>,
      platform: string,
      app: string,
    ) => doc.platforms[platform]?.apps.find((a) => a.name === app);

    it('says so above the install step, not below it', () => {
      const happ = card(proxy(), 'ios', 'Happ')!;
      const titles = happ.blocks.map((b) => b.title.en);
      expect(titles).toContain('Not in the Russian App Store');
      expect(titles.indexOf('Not in the Russian App Store')).toBeLessThan(
        titles.indexOf('Install the app'),
      );
      // A note under the step it invalidates arrives after the buyer has tried.
      expect(titles.indexOf('Not in the Russian App Store')).toBe(0);
    });

    it('keeps the app and says the installed copy still works', () => {
      const happ = card(proxy(), 'ios', 'Happ')!;
      const note = happ.blocks.find((b) => b.title.en === 'Not in the Russian App Store')!;
      expect(note.description.ru).toContain('продолжает');
      expect(note.description.en).toContain('keeps');
      // Dropping the app would take the instructions away from the buyers who
      // hold it and a working config.
      expect(card(proxy(), 'ios', 'Happ')).toBeDefined();
    });

    it('still marks the gap per platform, not per app', () => {
      // One app can be missing from the phone store and present on the TV one:
      // Happ's TV build is a different listing, and it is in this storefront.
      // This used to be checked through the "recommended" badge, which the
      // catalogue no longer carries — the property it was checking is the
      // per-platform gap, so it is checked directly now.
      const doc = proxy();
      const titles = (platform: string, app: string) =>
        card(doc, platform, app)!.blocks.map((b) => b.title.en);
      expect(titles('ios', 'Happ')).toContain('Not in the Russian App Store');
      expect(titles('appleTV', 'Happ')).not.toContain('Not in the Russian App Store');
      expect(titles('ios', 'Hiddify')).toContain('Not in the Russian App Store');
      expect(titles('android', 'Hiddify')).not.toContain('Not in the Russian App Store');
    });

    it('names alternatives from the same tab that can serve the same channels', () => {
      const doc = proxy();
      const note = card(doc, 'ios', 'Hiddify')!.blocks.find(
        (b) => b.title.en === 'Not in the Russian App Store',
      )!;
      const offered = new Set(doc.platforms.ios.apps.map((a) => a.name));
      const named = ['Shadowrocket', 'INCY'].filter((n) => note.description.ru.includes(n));
      expect(named.length).toBeGreaterThan(0);
      for (const n of named) expect(offered).toContain(n);
      // Never an app carrying a gap of its own: Streisand shares this
      // storefront, and sing-box has no listing anywhere at all — naming
      // either as the way out is the failure this sentence exists to avoid.
      expect(note.description.ru).not.toContain('Streisand');
      expect(note.description.ru).not.toContain('sing-box');
    });

    it('never says an alternative comes "from the store" where it does not', () => {
      // The macOS tab offers Hiddify, sing-box and Clash Verge, and not one of
      // them is in any store — they are the vendor's page and GitHub. Read off
      // the live document 2026-09-05, where the first wording told a Mac owner
      // exactly that.
      const doc = proxy();
      const notes = Object.values(doc.platforms).flatMap((p) =>
        p.apps.flatMap((a) => a.blocks.filter((b) => b.title.en.includes('App Store'))),
      );
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        const alt = n.description.ru.split('вкладке')[1] ?? '';
        expect(alt).not.toContain('из магазина');
      }
    });

    it('tells the two reasons apart, because the answers differ', () => {
      const doc = proxy();
      // Re-measured 2026-09-05: sing-box's listing answers resultCount 0 in the
      // US storefront too, so "get an account in another country" would be
      // advice that cannot work.
      const singbox = card(doc, 'ios', 'sing-box')!;
      const note = singbox.blocks.find((b) => b.title.ru === 'Сейчас нет в App Store')!;
      expect(note.description.ru).not.toContain('другой страны');
      expect(note.description.ru).toContain('похожими названиями');
      // And the storefront case still gives the answer that does work.
      const happ = card(doc, 'ios', 'Happ')!.blocks.find(
        (b) => b.title.ru === 'Нет в российском App Store',
      )!;
      expect(happ.description.ru).toContain('другой страны');
    });

    it('warns about the name-alikes where the store actually has some', () => {
      // Every wording of "this is not in your store" sends the buyer to search
      // for the name. Measured 2026-09-16 with
      // `search?term=<name>&country=ru`: Happ has four impostors in that
      // storefront (Happ VPN, Happ VPN Official, Happ VPN ++, Happ Lite),
      // V2Box has a straight collision, AmneziaVPN has one — and Hiddify and
      // Streisand have none. Until now only sing-box said so, in prose.
      const doc = proxy();
      const gapNote = (platform: string, app: string) =>
        card(doc, platform, app)!.blocks.find((b) => b.title.en.includes('App Store'))!;
      for (const app of ['Happ', 'V2Box']) {
        expect(gapNote('ios', app).description.ru, app).toContain('похожими названиями');
      }
      // And not where the search came back clean: an unmeasured warning is
      // noise on a block a stuck person is reading.
      for (const app of ['Hiddify', 'Streisand']) {
        expect(gapNote('ios', app).description.ru, app).not.toContain('похожими названиями');
      }
    });

    it('offers an iOS AmneziaWG buyer a client their own store sells', () => {
      const doc = buildSubpageConfig(
        input({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'nl-1', vpnKey: 'vpn://K' }] }),
      )!;
      const ios = doc.platforms.ios.apps;
      const names = ios.map((a) => a.name);
      // AmneziaVPN's listing is gone from this storefront; both of these are in
      // it, measured the same day and the same way.
      expect(names).toContain('DefaultVPN');
      expect(names).toContain('AmneziaWG');
      const dv = ios.find((a) => a.name === 'DefaultVPN')!;
      expect(dv.blocks.map((b) => b.title.en)).not.toContain('Not in the Russian App Store');
      // It takes the same key, and the copy must say ITS name, not the name of
      // the app this block was originally written for.
      const key = dv.blocks.find((b) => b.title.en === 'Paste the connection key')!;
      expect(key.description.ru).toContain('DefaultVPN');
      expect(key.buttons[0].link).toBe('vpn://K');
    });
  });

  // Measured the same way and the same day as the storefront probe above
  // (2026-09-16, `lookup?id=<id>&country=ru`, Telegram present / Proton VPN
  // absent as the controls): of everything the Russian storefront DOES carry,
  // exactly one client costs money. A buyer who taps "Get the app" and lands on
  // a price is the same interrupted install the notice above exists for.
  describe('an app the store sells for money', () => {
    const proxy = () => buildSubpageConfig(input({ protocols: ['xray', 'hysteria'] }))!;
    const card = (
      doc: NonNullable<ReturnType<typeof buildSubpageConfig>>,
      platform: string,
      app: string,
    ) => doc.platforms[platform]?.apps.find((a) => a.name === app);

    it('says so above the install step, not below it', () => {
      const sr = card(proxy(), 'ios', 'Shadowrocket')!;
      const titles = sr.blocks.map((b) => b.title.en);
      expect(titles).toContain('A paid app');
      expect(titles.indexOf('A paid app')).toBeLessThan(titles.indexOf('Install the app'));
      // First, for the same reason the storefront notice is first: it can make
      // the whole card moot before the buyer does any of the work.
      expect(titles.indexOf('A paid app')).toBe(0);
    });

    it('names the price, and dates it rather than pretending it is a constant', () => {
      const note = card(proxy(), 'ios', 'Shadowrocket')!.blocks.find(
        (b) => b.title.en === 'A paid app',
      )!;
      expect(note.description.ru).toContain('249');
      expect(note.description.en).toContain('249');
      // A price is a measurement, and a stale number with no date on it becomes
      // a lie. With the date it stays a fact, and the store page is named as
      // the authority.
      expect(note.description.ru).toContain('16.09.2026');
      expect(note.description.ru).toContain('App Store');
      // NOT "a one-off purchase": the listing carries the in-app purchases
      // badge, so that sentence would be false.
      expect(note.description.ru).not.toContain('разова');
    });

    it('carries the same notice on every tab that listing serves', () => {
      // One Apple listing, two of our tabs. Missing it on the second is how a
      // TV owner would meet the price with no warning at all.
      const tv = card(proxy(), 'appleTV', 'Shadowrocket')!;
      expect(tv.blocks.map((b) => b.title.en)).toContain('A paid app');
    });

    it('says nothing of the kind about the free clients on the same tab', () => {
      const doc = proxy();
      for (const app of ['INCY', 'Karing']) {
        const c = card(doc, 'ios', app);
        expect(c, `${app} is not offered on iOS`).toBeDefined();
        expect(c!.blocks.map((b) => b.title.en), app).not.toContain('A paid app');
      }
    });

    it('never offers a paid app as the way out of one the store does not carry', () => {
      // The alternatives sentence exists to name a way out that works. A client
      // the buyer has to pay 249 ₽ for is a different obstacle, not a way out —
      // and until this was measured we were naming it as one to every iPhone
      // buyer whose client is missing from the storefront.
      const doc = proxy();
      const notes = Object.values(doc.platforms).flatMap((p) =>
        p.apps.flatMap((a) =>
          a.blocks.filter((b) => b.title.en.includes('App Store') || b.title.en === 'A paid app'),
        ),
      );
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        const alt = n.description.ru.split('вкладке')[1] ?? '';
        expect(alt).not.toContain('Shadowrocket');
      }
    });

    it('offers the alternatives as free, not as "without that restriction"', () => {
      // Caught by READING the rendered document, not by a test: the first draft
      // shared one sentence with the storefront notice, so the paid card ended
      // "Karing и INCY ставятся без этого ограничения" — a restriction nobody
      // had mentioned, under a block whose whole subject is money. Every
      // assertion about that sentence was about WHO it names, and all of them
      // were green. Second time this exact class has shipped here.
      const note = card(proxy(), 'ios', 'Shadowrocket')!.blocks.find(
        (b) => b.title.en === 'A paid app',
      )!;
      expect(note.description.ru).toContain('бесплатно');
      expect(note.description.ru).not.toContain('без этого ограничения');
      expect(note.description.en).toContain('free');
      // And the storefront notice keeps its own wording, which is right there.
      const gap = card(proxy(), 'ios', 'Happ')!.blocks.find(
        (b) => b.title.ru === 'Нет в российском App Store',
      )!;
      expect(gap.description.ru).toContain('без этого ограничения');
    });

    it('agrees in number with the list it just built', () => {
      // "Karing ставятся" is what one form for both cases produces, and an
      // assertion on the name stays green through it.
      const doc = proxy();
      const notes = Object.values(doc.platforms).flatMap((p) =>
        p.apps.flatMap((a) =>
          a.blocks.filter(
            (b) =>
              (b.title.en.includes('App Store') || b.title.en === 'A paid app') &&
              b.description.ru.includes('вкладке'),
          ),
        ),
      );
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        const alt = n.description.ru.slice(n.description.ru.indexOf('вкладке'));
        const plural = / и [^ ]/.test(alt.split(/ставится|ставятся/)[0] ?? '');
        expect(alt, alt).toContain(plural ? 'ставятся' : 'ставится');
      }
    });

    it('still names somebody, on every tab where it says anything at all', () => {
      // The control this needs: dropping the paid client from the list must not
      // leave the sentence empty — an alternatives clause with nobody in it is
      // worse than none.
      const doc = proxy();
      const withAlts = Object.values(doc.platforms).flatMap((p) =>
        p.apps.flatMap((a) =>
          a.blocks.filter(
            (b) =>
              (b.title.en.includes('App Store') || b.title.en === 'A paid app') &&
              b.description.ru.includes('вкладке'),
          ),
        ),
      );
      expect(withAlts.length).toBeGreaterThan(0);
      for (const n of withAlts) {
        const alt = n.description.ru.split('вкладке')[1] ?? '';
        expect(alt.trim().length, n.description.ru).toBeGreaterThan(20);
      }
    });
  });

  // Both were already being served the right format — the seeded rules name
  // `(?i)karing` (singbox) and `(?i)v2box` (plain) since 20260617020000. They
  // were missing from the curated catalogue only, which is the same shape as
  // the Happ gap: the shop drew OUR list without a client our own panel knows
  // how to answer.
  describe('the two clients the shipped rules already serve', () => {
    const proxy = () => buildSubpageConfig(input({ protocols: ['xray', 'hysteria'] }))!;

    it('offers Karing on every platform its vendor publishes a build for', () => {
      const doc = proxy();
      for (const tab of ['ios', 'macos', 'appleTV', 'android', 'androidTV', 'windows', 'linux']) {
        expect(
          doc.platforms[tab]?.apps.map((a) => a.name),
          `Karing missing from ${tab}`,
        ).toContain('Karing');
      }
    });

    it('opens Karing with the scheme its own source registers', () => {
      // `karing://install-config?url=` — read off KaringX/karing
      // (`lib/screens/scheme_handler.dart`, and the scheme registered in
      // Info.plist and AndroidManifest), never guessed from a neighbouring app.
      const add = proxy()
        .platforms.ios.apps.find((a) => a.name === 'Karing')!
        .blocks.find((b) => b.title.en === 'Add the subscription')!;
      expect(add.buttons[0].link).toBe(
        `karing://install-config?url=${encodeURIComponent('https://panel.example/sub/tok')}`,
      );
    });

    it('gives the iPhone buyer a client their own store carries for free', () => {
      // The point of adding it, stated as a property: on the iOS tab Hiddify,
      // Streisand, Happ and V2Box are missing from this storefront and
      // Shadowrocket costs money.
      const ios = proxy().platforms.ios.apps;
      const karing = ios.find((a) => a.name === 'Karing')!;
      const titles = karing.blocks.map((b) => b.title.en);
      expect(titles).not.toContain('Not in the Russian App Store');
      expect(titles).not.toContain('A paid app');
      expect(karing.blocks.find((b) => b.title.en === 'Install the app')!.buttons[0].link).toBe(
        'https://apps.apple.com/app/id6472431552',
      );
    });

    it('tells a Karing buyer their routing rules arrive, and a V2Box buyer that they do not', () => {
      // The two differ by core, and the card reads `format`: Karing runs
      // sing-box and the seeded rule hands it `singbox`; V2Box gets the link
      // list. Saying the same thing about both is the failure that told Happ
      // buyers their config carried no rules while it carried five.
      const ios = proxy().platforms.ios.apps;
      const gives = (name: string) =>
        ios.find((a) => a.name === name)!.blocks.find((b) => b.title.en === 'What you get')!;
      expect(gives('Karing').description.ru).toContain('Правила приезжают вместе с конфигом');
      expect(gives('V2Box').description.ru).toContain('правил маршрутизации не несёт');
    });

    it('leads the V2Box card with the storefront it is missing from', () => {
      // Measured 2026-09-16: listing 6446814690 answers resultCount 0 under
      // country=ru and 1 under country=us. Added WITH the notice rather than
      // added and then explained.
      const v2box = proxy().platforms.ios.apps.find((a) => a.name === 'V2Box')!;
      expect(v2box.blocks[0].title.ru).toBe('Нет в российском App Store');
      expect(v2box.featured).toBe(false);
    });

    it('offers V2Box nowhere but the iPhone', () => {
      // Its listing says "Designed for iPad. Not verified for macOS", and the
      // publisher ships no Android build at all — the "V2Box" in the Russian
      // storefront is a different app by a different publisher.
      const doc = proxy();
      for (const [tab, platform] of Object.entries(doc.platforms)) {
        if (tab === 'ios') continue;
        expect(platform.apps.map((a) => a.name), tab).not.toContain('V2Box');
      }
    });
  });

  // The hole is real and the lock belongs to the client: a server-side password
  // was written, measured and reverted, because with Happ's factory setting it
  // kills the tunnel instead. What is left is telling the buyer.
  describe('the local proxy note', () => {
    const doc = () => buildSubpageConfig(input({ protocols: ['xray', 'hysteria'] }))!;
    const note = (platform: string, app: string) =>
      doc()
        .platforms[platform]?.apps.find((a) => a.name === app)
        ?.blocks.find((b) => b.title.en === 'Close the local proxy') ?? null;

    it('tells a Happ buyer to switch the authorisation on, and where', () => {
      const happ = note('android', 'Happ')!;
      expect(happ.description.ru).toContain('«Авто»');
      expect(happ.description.ru).toContain('ВЫКЛЮЧЕНА');
      expect(happ.description.ru).toContain('вашего адреса');
      // The path was read off a device (customer, 2026-09-05). "Open the
      // settings and find it" was the honest wording while nobody had looked,
      // and it is the wording a buyer writes to support about.
      expect(happ.description.ru).toContain('Inbounds');
      expect(happ.description.ru).toContain('шестерёнка');
      expect(happ.description.en).toContain('Inbounds');
    });

    it('gives no menu path for a client nobody has opened', () => {
      // A guessed route reads as authoritative and sends the buyer somewhere
      // that does not exist. INCY is the client we have not seen: it gets the
      // sentence without the path.
      const incy = note('android', 'INCY')!;
      expect(incy.description.ru).not.toContain('Inbounds');
      expect(incy.description.ru).toContain('настройках приложения');
    });

    it('tells an INCY buyer where it is, without telling them to turn on what is already on', () => {
      const incy = note('android', 'INCY')!;
      expect(incy.description.ru).toContain('по умолчанию');
      // The opposite advice to Happ's, and the reason the sentence is per
      // client: "turn it on" sends this buyer looking for a switch already
      // thrown.
      expect(incy.description.ru).not.toContain('ВЫКЛЮЧЕНА');
      expect(incy.description.en).toContain('nothing to do');
    });

    it('says nothing about a client whose setting we have not looked at', () => {
      // An unlooked-at client gets no sentence rather than a guessed one.
      expect(note('android', 'v2rayNG')).toBeNull();
      expect(note('ios', 'Shadowrocket')).toBeNull();
    });
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
