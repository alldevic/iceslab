import { describe, it, expect } from 'vitest';
import { amneziaQrChunkFromKey } from '../../core-adapters/amneziawg/vpnlink.js';
import { buildSubscriptionPage, type SubscriptionPageData } from './subscription.page.js';

function base(overrides: Partial<SubscriptionPageData> = {}): SubscriptionPageData {
  return {
    brandTitle: 'Iceslab',
    lang: 'en',
    subUrl: 'https://panel.example.com/sub/abc123',
    supportUrl: null,
    user: {
      username: 'alice',
      status: 'active',
      expireAt: null,
      trafficLimitBytes: null,
      trafficUsedBytes: 0,
    },
    protocols: ['hysteria'],
    ...overrides,
  };
}

describe('buildSubscriptionPage', () => {
  it('renders an HTML document with the subscription URL', () => {
    const html = buildSubscriptionPage(base());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('https://panel.example.com/sub/abc123');
    expect(html).toContain('alice');
  });

  it('offers Happ and v2RayTun with a working one-tap import', () => {
    // These two are what the operator's own subscribers run, and the page
    // listed neither: the most common reader was told to copy a link by hand
    // while every other client got a button. Schemes verified 2026-09-11
    // against docs.v2raytun.com/deep-link and the Happ-family deep-link docs.
    const html = buildSubscriptionPage(base({ protocols: ['xray'] }));
    expect(html).toContain('Happ');
    expect(html).toContain('happ://add/https://panel.example.com/sub/abc123');
    expect(html).toContain('v2RayTun');
    expect(html).toContain('v2raytun://import/https://panel.example.com/sub/abc123');
  });

  it('does not offer them to an AmneziaWG-only subscription', () => {
    // Neither speaks AWG obfuscation, so a button there would open an app that
    // cannot use the config, which is worse than no button.
    const html = buildSubscriptionPage(base({ protocols: ['amneziawg'] }));
    expect(html).not.toContain('happ://add/');
    expect(html).not.toContain('v2raytun://import/');
  });

  it('shows a per-node AmneziaWG .conf download only when an awg node exists', () => {
    const without = buildSubscriptionPage(base({ protocols: ['hysteria'] }));
    expect(without).not.toContain('format=wgconf');

    const withAwg = buildSubscriptionPage(
      base({ protocols: ['hysteria', 'amneziawg'], awgNodes: [{ nodeName: 'awg' }] }),
    );
    // .conf download is pinned to the node with &node=, and the ampersand is
    // written as an entity now, which is what an href should carry.
    expect(withAwg).toContain('format=wgconf&amp;node=awg');
  });

  it('multi-node: a server selector + one QR per (node, app), not a stacked tower', () => {
    const html = buildSubscriptionPage(
      base({
        protocols: ['amneziawg'],
        awgNodes: [
          { nodeName: 'awg', vpnKey: 'vpn://nl', conf: '[Interface] nl' },
          { nodeName: 'awg-de', vpnKey: 'vpn://de', conf: '[Interface] de' },
        ],
      }),
    );
    // every node's payload is on the page (shown/hidden client-side), which is
    // what the browser draws its code from. The AmneziaVPN one in the app's own
    // chunk format (E39), the .conf as it is...
    for (const text of [
      amneziaQrChunkFromKey('vpn://nl'),
      '[Interface] nl',
      amneziaQrChunkFromKey('vpn://de'),
      '[Interface] de',
    ]) {
      expect(html).toContain(`data-qr-text="${text}"`);
    }
    // ...behind a per-node server selector, which is the same control as the
    // platform one in "Set up": two selectors behaving differently on one
    // page is a cost the reader pays.
    expect(html).toContain('class="platform" data-node-picker');
    expect(html).toContain('class="platform__item is-on"');
    expect(html).toContain('data-target="awg:awg"');
    expect(html).toContain('data-target="awg:awg-de"');
    // ...and an AmneziaVPN / AmneziaWG app toggle.
    expect(html).toContain('data-app="vpn"');
    expect(html).toContain('data-app="conf"');
    // figures are keyed by (node, app) so the script can swap them in place.
    expect(html).toContain('data-target="awg:awg-de" data-app="vpn"');
    expect(html).toContain('data-target="awg:awg-de" data-app="conf"');
    // per-node .conf download still offered in the downloads card.
    expect(html).toContain('format=wgconf&amp;node=awg-de');
  });

  it('gives Android TV exactly three apps, and these three', () => {
    // The one test worth more than the rest of this file. Three clients cover
    // a television honestly: Happ, Karing, INCY. Everything else either has no
    // Android TV build or installs and then cannot be driven with a remote,
    // and both of those were in the registry as recently as this week. This
    // fails the day somebody "fixes" the registry from memory.
    const html = buildSubscriptionPage(base({ protocols: ['xray', 'shadowsocks', 'hysteria'] }));
    const panel = html.slice(html.indexOf('data-platform="androidtv"'));
    const body = panel.slice(0, panel.indexOf('</section>'));
    const names = [...body.matchAll(/class="app-card__name">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(['Happ', 'Karing', 'INCY']);
    // And it says so out loud, because a short list reads like a sample.
    expect(body).toContain('whole list');
  });

  it('offers an MTProto-only subscription no config format at all', () => {
    // The bug this is about: the page asked "is there anything that is not
    // AmneziaWG" and called that a proxy, so an MTProto node was offered
    // Clash, sing-box, Xray JSON and two paid iOS clients. No builder emits
    // MTProto, so every one of those files came back without its only server.
    const html = buildSubscriptionPage(base({ protocols: ['mtproto'] }));
    for (const fmt of ['clash', 'singbox', 'xrayjson', 'xrayjson-array', 'surge', 'loon']) {
      expect(html, `${fmt} was offered to a subscription it cannot carry`).not.toContain(
        `?format=${fmt}`,
      );
    }
    // `plain` stays: it is the subscription itself, and it carries everything.
    expect(html).toContain('?format=plain');
  });

  it('hands an MTProto node its proxy link, which is the only way to use one', () => {
    // MTProto is in no config format, so without this row the page shows a
    // Telegram card of instructions and no link: the only route was reading
    // the raw subscription by hand.
    const html = buildSubscriptionPage(
      base({
        protocols: ['mtproto'],
        mtprotoNodes: [
          {
            nodeName: 'se-01',
            uri: 'tg://proxy?server=se-01.example.com&port=443&secret=ee00',
            tmeUri: 'https://t.me/proxy?server=se-01.example.com&port=443&secret=ee00',
          },
        ],
      }),
    );
    // The https form on the button: it opens the app from anywhere and
    // survives being sent to somebody.
    expect(html).toContain('https://t.me/proxy?server=se-01.example.com&amp;port=443');
    expect(html).toContain('data-copy-text=');
    // Named by node, like the per-server AmneziaWG files, because that is what
    // it is: one server, not the subscription.
    expect(html).toContain('se-01');
  });

  it('puts the Telegram rows under the one "another device" title, not a second copy of it', () => {
    const html = buildSubscriptionPage(
      base({
        protocols: ['mtproto'],
        mtprotoNodes: [{ nodeName: 'se-01', uri: 'tg://proxy?x', tmeUri: 'https://t.me/proxy?x' }],
      }),
    );
    expect(html.match(/data-dl-group="other"/g)?.length).toBe(1);
    expect(html.split('FOR ANOTHER DEVICE').length - 1).toBe(1);
  });

  it('says nothing about Telegram when no node serves it', () => {
    const html = buildSubscriptionPage(base({ protocols: ['xray'] }));
    expect(html).not.toContain('data-copy-text=');
    expect(html).not.toContain('t.me/proxy');
  });

  it('hides a platform that has nothing to offer instead of showing an empty one', () => {
    // An AmneziaWG-only subscription has no client for a television at all:
    // AmneziaVPN does not build for one. The platform leaves the selector.
    const html = buildSubscriptionPage(
      base({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'de-01' }] }),
    );
    expect(html).not.toContain('data-pick="androidtv"');
    expect(html).not.toContain('data-platform="androidtv"');
    // The ones that do have a client are still there.
    expect(html).toContain('data-pick="android"');
  });

  it('offers the Telegram row only where the proxy exists and the app has the field', () => {
    // Two conditions, and neither is cosmetic: Telegram on a television and on
    // a router does not exist, the web client has no proxy settings at all,
    // and a subscription without an MTProto endpoint has no telegram proxy to
    // configure in the first place.
    const withTg = buildSubscriptionPage(base({ protocols: ['xray', 'mtproto'] }));
    const panelOf = (html: string, p: string) => {
      const from = html.slice(html.indexOf(`data-platform="${p}"`));
      return from.slice(0, from.indexOf('</section>'));
    };
    for (const p of ['ios', 'android', 'windows', 'macos', 'linux']) {
      expect(panelOf(withTg, p), p).toContain('class="tg-row"');
    }
    for (const p of ['androidtv', 'appletv']) {
      expect(panelOf(withTg, p), p).not.toContain('class="tg-row"');
    }
    // No MTProto in the subscription, no row anywhere.
    expect(buildSubscriptionPage(base({ protocols: ['xray'] }))).not.toContain('class="tg-row"');
  });

  it('splits the apps into the ones that just work and the ones that do not', () => {
    const html = buildSubscriptionPage(base({ protocols: ['xray', 'shadowsocks', 'hysteria'] }));
    const from = html.slice(html.indexOf('data-platform="windows"'));
    const panel = from.slice(0, from.indexOf('</section>'));
    expect(panel).toContain('INSTALL AND IT WORKS');
    expect(panel).toContain('FOR FINE CONTROL, HARDER');
    // v2rayN is a routing console and must never be in the row above the fold:
    // it is the wrong answer to "what do I install".
    const row = panel.slice(0, panel.indexOf('all-apps'));
    expect(row).not.toContain('v2rayN');
    expect(row).toContain('Happ');
  });

  it('names what each download format is for, and never prints the config itself', () => {
    const html = buildSubscriptionPage(base({ protocols: ['xray', 'shadowsocks'] }));
    expect(html).toContain('Clash-compatible');
    // Grouped by purpose. A router file must stay reachable from a laptop:
    // taking a config file is what people do FOR another device.
    expect(html).toContain('data-dl-group="router"');
    expect(html).toContain('data-dl-group="clients"');
    // The download flag is separate from the format, and `plain` never gets it.
    expect(html).toContain('format=clash&amp;dl=1');
    expect(html).not.toContain('format=plain&amp;dl=1');
    // The one place a secret would stop being hidden behind the token.
    expect(html).toContain('plain text');
  });

  it('gives Outline one ssconf:// key per node, and no card without one', () => {
    // An Outline key carries one server, so a key per node, as the AmneziaWG
    // pairs. Without a key (no node on a cipher Outline reads) there is no
    // Outline card at all: an app card that leads nowhere is the defect.
    const key = (n: string) =>
      `ssconf://panel.example.com/sub/abc123?format=outline&node=${n}#${n}`;
    const none = buildSubscriptionPage(base({ protocols: ['xray', 'shadowsocks'] }));
    expect(none).not.toContain('data-app="Outline"');
    expect(none).not.toContain('format=outline');

    const two = buildSubscriptionPage(
      base({
        protocols: ['xray', 'shadowsocks'],
        outlineNodes: [
          { nodeName: 'de-1', key: key('de-1') },
          { nodeName: 'nl-1', key: key('nl-1') },
        ],
      }),
    );
    expect(two).toContain('data-app="Outline"');
    for (const n of ['de-1', 'nl-1']) {
      const k = key(n).replace(/&/g, '&amp;');
      expect(two).toContain(`data-copy-text="${k}"`);
      expect(two).toContain(`href="${k}"`);
      expect(two).toContain(`Outline · ${n}`);
    }
    // Never as a file to download: the app imports the key, not a file.
    expect(two).not.toContain('format=outline&amp;dl=1');
  });

  it('warns before the traffic runs out, and says what actually happens then', () => {
    // "Speed will drop" would be a lie here: the limit flips the user to
    // `limited` and the subscription stops answering (subscription.service.ts).
    const gib = 1024 * 1024 * 1024;
    const html = buildSubscriptionPage(
      base({
        lang: 'ru',
        user: { ...base().user, trafficLimitBytes: 200 * gib, trafficUsedBytes: 196 * gib },
      }),
    );
    expect(html).toContain('Осталось 4.0 GiB из 200 GiB');
    expect(html).toContain('доступ остановится');
    expect(html).toContain('tile--warn');
  });

  it('always offers the generic proxy format downloads', () => {
    const html = buildSubscriptionPage(base());
    for (const f of ['format=clash', 'format=singbox', 'format=xrayjson', 'format=plain']) {
      expect(html).toContain(f);
    }
  });

  it('HTML-escapes admin/user-controlled fields (XSS defence)', () => {
    const html = buildSubscriptionPage(
      base({
        brandTitle: '<script>alert(1)</script>',
        user: {
          username: '"><img src=x onerror=alert(1)>',
          status: 'active',
          expireAt: null,
          trafficLimitBytes: null,
          trafficUsedBytes: 0,
        },
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('states the traffic as a figure, with or without a limit', () => {
    // The progress bar is gone on purpose: the card is four tiles now, and a
    // bar that is 25% full says less than "25 / 100 GiB" in the same space.
    const unlimited = buildSubscriptionPage(base({ user: { ...base().user, trafficLimitBytes: null } }));
    expect(unlimited).not.toContain('class="bar"');
    expect(unlimited).toContain('unlimited');

    const limited = buildSubscriptionPage(
      base({
        user: { ...base().user, trafficLimitBytes: 100 * 1024 * 1024 * 1024, trafficUsedBytes: 25 * 1024 * 1024 * 1024 },
      }),
    );
    expect(limited).toContain('25.0 GiB / 100 GiB');
  });

  it('localizes labels by lang', () => {
    expect(buildSubscriptionPage(base({ lang: 'en' }))).toContain('Subscription link');
    expect(buildSubscriptionPage(base({ lang: 'ru' }))).toContain('Ссылка подписки');
  });

  it('prints the date the way a person writes it, in their language', () => {
    // It used to print toISOString().slice(0,10). 2026-12-10 is a machine's
    // date: half the world reads it as the tenth of December and the other
    // half reads nothing at all.
    const at = '2026-12-10T00:00:00.000Z';
    expect(buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: at } })))
      // Genitive, which is what makes it Russian rather than translated.
      .toContain('10 декабря, 2026');
    expect(buildSubscriptionPage(base({ lang: 'en', user: { ...base().user, expireAt: at } })))
      .toContain('December 10, 2026');
  });

  it('counts the days left, and counts them in Russian', () => {
    // Three forms, and the wrong one is the loudest sign a page was written
    // somewhere else. The dates are far enough out to stay in the plain state.
    const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
    expect(buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: days(82) } })))
      .toContain('осталось 82 дня');
    expect(buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: days(21) } })))
      .toContain('осталось 21 день');
    expect(buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: days(15) } })))
      .toContain('осталось 15 дней');
    expect(buildSubscriptionPage(base({ lang: 'en', user: { ...base().user, expireAt: days(82) } })))
      .toContain('82 days left');
    // No date at all is its own sentence, not "0 days".
    expect(buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: null } })))
      .toContain('без срока');
  });

  it('turns amber in the last week, while the subscription still works', () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    const html = buildSubscriptionPage(base({ lang: 'ru', user: { ...base().user, expireAt: soon } }));
    expect(html).toContain('Истекает через 3 дня');
    expect(html).toContain('sub-card__badge--warn');
    expect(html).toContain('tile--warn');
    // The status itself is still green: it works, and that is the difference
    // between a warning and a refusal.
    expect(html).toContain('tile--ok');
  });

  it('renders an in-page RU/EN selector marking the active locale', () => {
    const en = buildSubscriptionPage(base({ lang: 'en' }));
    // both links present (server-side re-render via ?lang=, no JS)
    expect(en).toContain('href="?lang=ru"');
    expect(en).toContain('href="?lang=en"');
    // active locale is the filled one
    expect(en).toContain('class="lng on" href="?lang=en"');
    expect(en).not.toContain('class="lng on" href="?lang=ru"');

    const ru = buildSubscriptionPage(base({ lang: 'ru' }));
    expect(ru).toContain('class="lng on" href="?lang=ru"');
    expect(ru).not.toContain('class="lng on" href="?lang=en"');
  });

  it('emits a support link only when supportUrl is set', () => {
    expect(buildSubscriptionPage(base({ supportUrl: null }))).not.toContain('class="support"');
    expect(buildSubscriptionPage(base({ supportUrl: 'https://t.me/support' }))).toContain(
      'https://t.me/support',
    );
  });

  it('a link out of the page hands the next site neither the page nor its URL (AUDT, A-267)', () => {
    const html = buildSubscriptionPage(base({ supportUrl: 'https://t.me/support' }));
    expect(html).toMatch(/<a class="support" [^>]*rel="noopener noreferrer"/);
    const outward = [...html.matchAll(/<a [^>]*(?:target="_blank"|data-app-get)[^>]*>/g)].map((m) => m[0]);
    expect(outward.length).toBeGreaterThan(0);
    for (const a of outward) expect(a, a).toContain('rel="noopener noreferrer"');
  });

  it('puts the subscription QR in the transfer window, and only there', () => {
    // It used to sit in the scan card as well. The same code twice is the most
    // expensive decoration available on a page opened over a link that may
    // barely work, and now also a second encode on the reader's phone.
    const html = buildSubscriptionPage(base());
    expect(html).toContain('class="overlay" data-transfer');
    // One box for the link, in the plate, and nowhere else.
    expect(html.split('data-qr-text="https://panel.example.com/sub/abc123"').length - 1).toBe(1);
    // The scan card is now the AmneziaWG widget alone: a proxy-only
    // subscription has nothing to put in it.
    expect(html).not.toContain('class="qrview"');
  });

  it('leaves a reader with no JavaScript the link itself where the code would be', () => {
    // The rule this page has always held (checklist 34) and the one the move to
    // browser-drawn codes could most easily break: a QR is a convenience, the
    // link is the substance. The container carries the text to encode in a data
    // attribute, and the same text readable inside it, with a line saying why
    // the picture is missing.
    const html = buildSubscriptionPage(base());
    const box = html.slice(html.indexOf('<div class="qr-plate">'));
    expect(box).toContain('data-qr-pending');
    expect(box).toContain('data-qr-text="https://panel.example.com/sub/abc123"');
    expect(box).toContain('https://panel.example.com/sub/abc123</code>');
    expect(box).toContain('turn JavaScript on');
    // And the encoder that turns it into a picture ships with the page: no
    // external asset, because this page is opened on networks where a CDN is
    // a blocked hostname.
    expect(html).toContain('qrcodegen');
    expect(html).not.toContain('<script src=');
  });

  it('offers the transfer button only where a camera could read the code', () => {
    // A television and a router have no camera, and the code works the other
    // way round there anyway: what is needed is getting the link ONTO the
    // device. The button is in the page header, so the platform switch is what
    // takes it away, and the list it switches on is in the page's own script.
    const html = buildSubscriptionPage(base());
    expect(html).toContain('data-open-transfer');
    expect(html).toContain('var NO_TRANSFER = ["androidtv","appletv","router"]');
  });

  it('single AWG node: no server selector, caption is just the app name', () => {
    const html = buildSubscriptionPage(
      base({ protocols: ['amneziawg'], awgNodes: [{ nodeName: 'awg', vpnKey: 'vpn://one' }] }),
    );
    // E39: the code is the app's chunk, drawn at LOW like the app's own; the key
    // itself is what the copy button and the no-JS fallback carry.
    expect(html).toContain(`data-qr-text="${amneziaQrChunkFromKey('vpn://one')}" data-qr-ecc="low"`);
    expect(html).not.toContain('data-qr-text="vpn://one"');
    expect(html).toContain('data-key="vpn://one"');
    expect(html).toContain('<code class="qbx__text">vpn://one</code>');
    // figure caption is the app name, never a "· awg" node suffix (the node
    // lives in the selector now)
    expect(html).toContain('<figcaption>AmneziaVPN</figcaption>');
    expect(html).not.toContain('<figcaption>AmneziaVPN · awg</figcaption>');
    // a single target → no server selector segment
    // The attribute as MARKUP: the page's own script names it too.
    expect(html).not.toContain('class="platform" data-node-picker');
  });

  describe('the operator wording for a subscription that is not in force', () => {
    const lapsed = (over: Partial<SubscriptionPageData> = {}) =>
      base({
        user: {
          username: 'alice',
          status: 'expired',
          expireAt: null,
          trafficLimitBytes: null,
          trafficUsedBytes: 0,
        },
        protocols: [],
        ...over,
      });

    it('prints what the operator wrote, in the language being served', () => {
      const html = buildSubscriptionPage(
        lapsed({
          lang: 'ru',
          deadTexts: { expired: { ru: 'Пишите @support, продлим', en: 'Write to @support' } },
        }),
      );
      expect(html).toContain('Пишите @support, продлим');
      expect(html).not.toContain('The subscription has run out');
    });

    it('falls back to ours when the other language is the one filled in', () => {
      const html = buildSubscriptionPage(
        lapsed({ lang: 'en', deadTexts: { expired: { ru: 'Только по-русски' } } }),
      );
      expect(html).toContain('The subscription has run out');
      expect(html).not.toContain('Только по-русски');
    });

    // An operator who cleared the box asked for OUR text back, not for a blank
    // line. The reader of this page already cannot connect; taking the
    // explanation away as well would be the worst of both.
    it('treats an emptied box as "use ours", not as "print nothing"', () => {
      for (const wording of ['', '   ']) {
        const html = buildSubscriptionPage(
          lapsed({ lang: 'en', deadTexts: { expired: { en: wording } } }),
        );
        expect(html).toContain('The subscription has run out');
      }
    });

    it('does not let one state speak for another', () => {
      const html = buildSubscriptionPage(
        lapsed({ lang: 'en', deadTexts: { limited: { en: 'Out of traffic, ask us' } } }),
      );
      expect(html).toContain('The subscription has run out');
      expect(html).not.toContain('Out of traffic, ask us');
    });

    // A withdrawn link is a different address, not a state of the subscription,
    // and the settings carry no key for it on purpose.
    it('keeps our own words for a withdrawn link', () => {
      const html = buildSubscriptionPage(
        lapsed({
          lang: 'en',
          user: {
            username: 'alice',
            status: 'revoked',
            expireAt: null,
            trafficLimitBytes: null,
            trafficUsedBytes: 0,
          },
          deadTexts: { disabled: { en: 'Switched off by us' } },
        }),
      );
      expect(html).toContain('This link has been withdrawn');
      expect(html).not.toContain('Switched off by us');
    });
  });
});

describe('the refusal page', () => {
  /**
   * Three things and nothing else: the state card, the link with its copy
   * button, and support when there is one.
   *
   * Everything else on this page answers "how do I connect", and for this
   * reader there is one honest answer. Install steps and eight app panels are
   * then a person following instructions into a wall, and the config button is
   * worse than decoration: every format goes through the same generator that
   * refused, so pressing it returns a 403.
   */
  const DEAD = ['expired', 'limited', 'disabled'] as const;

  for (const status of DEAD) {
    it(`offers no apps and no configs when the subscription is ${status}`, () => {
      const html = buildSubscriptionPage(
        base({
          protocols: ['xray', 'amneziawg'],
          awgNodes: [{ nodeName: 'awg', conf: '[Interface] dead', vpnKey: 'vpn://dead' }],
          user: {
            username: 'alice',
            status,
            expireAt: '2026-01-01T00:00:00.000Z',
            trafficLimitBytes: 1024,
            trafficUsedBytes: 2048,
          },
        }),
      );

      // No install block, no app cards, no one-tap import.
      expect(html).not.toContain('class="card install"');
      expect(html).not.toContain('happ://add/');
      expect(html).not.toContain('v2raytun://import/');
      // No downloads card and no config buttons.
      expect(html).not.toContain('id="downloads"');
      // The attribute, not the bare word: the inline script names it in a
      // selector and a comment, and matching those would test the wrong file.
      expect(html).not.toContain('data-copy-config="');
      expect(html).not.toContain('format=wgconf');
      // No AmneziaWG QR widget and no transfer window: moving a subscription
      // that does not work to a second device is not a thing to offer.
      expect(html).not.toContain('id="scan"');
      expect(html).not.toContain('class="overlay" data-transfer');
      // And no code payloads either: the codes are drawn from text the page
      // carries, so a suppressed widget that still shipped the key would hand
      // over the config it just refused to offer.
      expect(html).not.toContain('vpn://dead');
      expect(html).not.toContain('[Interface] dead');

      // And the three that stay.
      expect(html).toContain('sub-card');
      expect(html).toContain('https://panel.example.com/sub/abc123');
      expect(html).toContain('id="copy-inline"');
      // The line that answers the question this page always raises.
      expect(html).toContain('The link does not change');
    });
  }

  it('keeps the whole directory for a LIVE subscription with no servers yet', () => {
    // The other rule, and the one this must not break: an empty protocol list
    // on a working subscription means the fleet is unreachable, not that the
    // person cannot install anything. The page used to go blank there.
    const html = buildSubscriptionPage(base({ protocols: [] }));
    expect(html).toContain('class="card install"');
    expect(html).toContain('id="downloads"');
    // Apps from protocols nobody has yet: the directory, not the subscription.
    expect(html).toContain('Happ');
    expect(html).not.toContain('The link does not change');
  });
});
describe('the apps the page offers against what the formats give', () => {
  const names = (html: string, platform: string) => {
    const panel = html.slice(html.indexOf(`data-platform="${platform}"`));
    const body = panel.slice(0, panel.indexOf('</section>'));
    return [...body.matchAll(/class="app-card__name">([^<]+)</g)].map((m) => m[1]);
  };

  it('hides the sing-box clients on an XHTTP-only fleet and keeps the others', () => {
    const all = ['plain', 'singbox', 'mihomo', 'xrayjson'] as const;
    const withBoth = buildSubscriptionPage(base({ protocols: ['xray'], usableFormats: [...all] }));
    const xhttp = buildSubscriptionPage(base({ protocols: ['xray'], usableFormats: ['plain', 'mihomo', 'xrayjson'] }));
    for (const n of ['Hiddify', 'sing-box', 'Karing']) {
      expect(names(withBoth, 'ios'), n).toContain(n);
      expect(names(xhttp, 'ios'), n).not.toContain(n);
    }
    expect(names(xhttp, 'ios')).toContain('Happ');
    expect(names(xhttp, 'android')).toContain('v2rayNG');
    expect(xhttp).not.toContain('sing-box://import-remote-profile');
    expect(xhttp).not.toContain('hiddify://import/');
  });

  it('does not break on no usable format: only the apps without a format are left', () => {
    const html = buildSubscriptionPage(base({ protocols: ['xray', 'amneziawg'], awgNodes: [{ nodeName: 'awg' }], usableFormats: [] }));
    expect(html).toContain('<!DOCTYPE html>');
    expect([...names(html, 'ios')].sort()).toEqual(['AmneziaVPN', 'AmneziaWG', 'DefaultVPN', 'INCY']);
  });

  it('takes the first client of the steps from the filtered list', () => {
    // Hiddify is the first of its tab by registry order; the "get" button of
    // the steps must name the first one that is still offered.
    const html = buildSubscriptionPage(base({ protocols: ['xray'], usableFormats: ['plain'] }));
    const steps = html.slice(html.indexOf('data-app-get'));
    expect(steps.slice(0, 600)).not.toContain('Hiddify');
  });

  it('does not filter when the data carries no usable list', () => {
    expect(names(buildSubscriptionPage(base({ protocols: ['xray'] })), 'ios')).toContain('Hiddify');
  });

  it('shows V2Box and DefaultVPN on iOS, and WG Tunnel on Android for plain WireGuard', () => {
    const ios = buildSubscriptionPage(
      base({ protocols: ['xray', 'amneziawg'], awgNodes: [{ nodeName: 'awg' }] }),
    );
    expect(names(ios, 'ios')).toEqual(expect.arrayContaining(['V2Box', 'DefaultVPN']));
    expect(names(ios, 'android')).not.toContain('V2Box');
    expect(names(ios, 'macos')).not.toContain('V2Box');

    const wg = buildSubscriptionPage(
      base({ protocols: ['wireguard'], wgNodes: [{ nodeName: 'wg', id: 'wg1', device: 1, file: 'x.conf', conf: '[Interface]' } as never] }),
    );
    expect(names(wg, 'android')).toEqual(expect.arrayContaining(['WireGuard', 'WG Tunnel']));
    expect(names(wg, 'ios')).not.toContain('WG Tunnel');
    expect(names(buildSubscriptionPage(base({ protocols: ['xray'] })), 'android')).not.toContain('WG Tunnel');
  });
});

describe('the store marks on the cards', () => {
  const card = (html: string, platform: string, name: string) => {
    const panel = html.slice(html.indexOf(`data-platform="${platform}"`));
    const body = panel.slice(0, panel.indexOf('</section>'));
    const i = body.indexOf(`data-app="${name}"`);
    return i < 0 ? '' : body.slice(i, body.indexOf('</button>', i));
  };
  const page = buildSubscriptionPage(base({ protocols: ['xray', 'shadowsocks', 'hysteria'] }));

  it('marks an app the Russian store does not carry, on the platform where that is so', () => {
    expect(card(page, 'ios', 'V2Box')).toContain('app-card__flag--nostore');
    expect(card(page, 'ios', 'V2Box')).toContain('Not in the RU App Store');
    expect(card(page, 'ios', 'Streisand')).toContain('app-card__flag--nostore');
    // The macOS listing is one id with the iOS one.
    expect(card(page, 'macos', 'Streisand')).toContain('app-card__flag--nostore');
  });

  it('marks a paid app with its price, on both Apple platforms it is sold on', () => {
    expect(card(page, 'ios', 'Shadowrocket')).toContain('app-card__flag--paid');
    expect(card(page, 'ios', 'Shadowrocket')).toContain('Paid · 249 ₽');
    expect(card(page, 'appletv', 'Shadowrocket')).toContain('249 ₽');
    expect(card(page, 'macos', 'Shadowrocket')).not.toContain('app-card__flag');
  });

  it('marks nothing off the Apple platforms and nothing on an app without the field', () => {
    for (const p of ['android', 'windows', 'linux', 'androidtv']) {
      const panel = page.slice(page.indexOf(`data-platform="${p}"`));
      expect(panel.slice(0, panel.indexOf('</section>')), p).not.toContain('app-card__flag');
    }
    // Happ is out of the store on iOS and macOS, not on Apple TV or Android.
    expect(card(page, 'appletv', 'Happ')).not.toContain('app-card__flag');
    expect(card(page, 'android', 'Happ')).not.toContain('app-card__flag');
    // A card without a field is the card the base drew.
    expect(card(page, 'ios', 'Karing')).toMatch(/^data-app="Karing"[^>]*><span class="app-card__dot"><\/span><span class="app-card__name">Karing<\/span>/);
  });

  it('draws no recommendation dot where the app is not in the store, and keeps it elsewhere', () => {
    expect(card(page, 'ios', 'Happ')).not.toContain('app-card__dot');
    expect(card(page, 'appletv', 'Happ')).toContain('app-card__dot');
    expect(card(page, 'android', 'Happ')).toContain('app-card__dot');
  });

  it('says it in Russian too', () => {
    const ru = buildSubscriptionPage(base({ lang: 'ru', protocols: ['xray'] }));
    expect(card(ru, 'ios', 'V2Box')).toContain('Нет в российском App Store');
    expect(card(ru, 'ios', 'Shadowrocket')).toContain('Платное · 249 ₽');
  });
});

describe('the scan block opens on the tunnel a link named', () => {
  const nodes = [
    { nodeName: 'awg-one', id: 'aaaaaaa1', vpnKey: 'vpn://one', conf: '[Interface] one' },
    { nodeName: 'awg-two', id: 'bbbbbbb2', vpnKey: 'vpn://two', conf: '[Interface] two' },
    { nodeName: 'awg-two', id: 'bbbbbbb2', device: 2, vpnKey: 'vpn://two2', conf: '[Interface] two2' },
  ];
  const wgNodes = [{ nodeName: 'wg-one', id: 'ccccccc3', conf: '[Interface] wg' }];
  const active = (html: string) =>
    [...html.matchAll(/<figure class="qrf on" data-target="([^"]+)"(?: data-app="(\w+)")?/g)].map((m) => `${m[1]}/${m[2] ?? ''}`);

  it('without a preselection the first node opens on its AmneziaVPN code, as before', () => {
    const html = buildSubscriptionPage(base({ protocols: ['amneziawg', 'wireguard'], awgNodes: nodes, wgNodes }));
    expect(active(html)).toEqual(['awg:awg-one/vpn']);
    expect(html).toContain('data-node-name>AmneziaWG · awg-one<');
    expect(html).toMatch(/seg-btn is-on" type="button" role="tab" aria-selected="true" data-app="vpn"/);
  });

  it('an AmneziaWG tunnel opens on its .conf code, server and app switch to match', () => {
    const html = buildSubscriptionPage(
      base({ protocols: ['amneziawg', 'wireguard'], awgNodes: nodes, wgNodes, preselect: { id: 'bbbbbbb2' } }),
    );
    expect(active(html)).toEqual(['awg:awg-two/conf']);
    expect(html).toContain('data-node-name>AmneziaWG · awg-two<');
    expect(html).toMatch(/seg-btn is-on" type="button" role="tab" aria-selected="true" data-app="conf"/);
  });

  it('the device is part of the name', () => {
    const html = buildSubscriptionPage(
      base({ protocols: ['amneziawg'], awgNodes: nodes, preselect: { id: 'bbbbbbb2', device: 2 } }),
    );
    expect(active(html)).toEqual(['awg:awg-two #2/conf']);
  });

  it('a plain WireGuard tunnel opens on its own code', () => {
    const html = buildSubscriptionPage(
      base({ protocols: ['amneziawg', 'wireguard'], awgNodes: nodes, wgNodes, preselect: { id: 'ccccccc3' } }),
    );
    expect(active(html)).toEqual(['wg:wg-one/']);
  });

  it('a name the page does not hold is the page without it', () => {
    const plain = buildSubscriptionPage(base({ protocols: ['amneziawg'], awgNodes: nodes }));
    const html = buildSubscriptionPage(base({ protocols: ['amneziawg'], awgNodes: nodes, preselect: { id: 'zzzzzzz9' } }));
    expect(html).toBe(plain);
  });
});

describe('the local proxy step of the install guide', () => {
  const panelOf = (html: string, p: string) => {
    const from = html.slice(html.indexOf(`data-platform="${p}"`));
    return from.slice(0, from.indexOf('</section>'));
  };
  const steps = (body: string) => (body.match(/<div class="step[ "]/g) ?? []).length;
  const warn = (body: string) => [...body.matchAll(/<div class="step step--warn" data-local-proxy="([^"]+)"( hidden)?>/g)];

  it('is there when Happ leads the row, with the menu path, and is the only step added', () => {
    const body = panelOf(buildSubscriptionPage(base({ protocols: ['xray'] })), 'android');
    expect(body).toContain('class="app-card__name">Happ<');
    expect(body.indexOf('class="app-card__name">Happ<')).toBeLessThan(body.indexOf('app-card__name">v2RayTun<'));
    const w = warn(body);
    expect(w.map((m) => [m[1], m[2]])).toEqual([['Happ', undefined]]);
    expect(body).toContain('Close the local proxy');
    expect(body).toContain('Inbounds');
    expect(steps(body)).toBe(5);
  });

  it('speaks the page language', () => {
    const body = panelOf(buildSubscriptionPage(base({ lang: 'ru', protocols: ['xray'] })), 'android');
    expect(body).toContain('Закройте локальный прокси');
    expect(body).toContain('Входящие соединения');
  });

  it('is there for every platform that carries Happ outside the TV tab and keeps the four steps without it', () => {
    const html = buildSubscriptionPage(base({ protocols: ['xray'] }));
    for (const p of ['ios', 'android', 'windows', 'macos', 'linux']) {
      expect(warn(panelOf(html, p)).length, p).toBe(1);
    }
    // No Happ among the clients (only a singbox-format fleet): four steps, no mark.
    const noHapp = buildSubscriptionPage(base({ protocols: ['xray'], usableFormats: ['singbox'] }));
    expect(panelOf(noHapp, 'android')).not.toContain('Happ');
    expect(panelOf(noHapp, 'android')).not.toContain('data-local-proxy');
    expect(steps(panelOf(noHapp, 'android'))).toBe(4);
  });

  it('is not on the television and router tabs', () => {
    const html = buildSubscriptionPage(
      base({ protocols: ['xray', 'amneziawg'], awgNodes: [{ nodeName: 'awg' }] }),
    );
    for (const p of ['androidtv', 'appletv', 'router']) {
      expect(panelOf(html, p), p).not.toContain('data-local-proxy');
    }
  });

  it('is hidden when another client leads the row, ready for the script to show it', () => {
    // singbox and plain both usable but a fleet that only a non-Happ client leads is
    // not constructible from data, so check the draw rule through the mark itself:
    // the marker is hidden exactly when its client is not the first one.
    const body = panelOf(buildSubscriptionPage(base({ protocols: ['xray'] })), 'ios');
    const first = /class="app-card__name">([^<]+)</.exec(body)![1];
    for (const m of warn(body)) expect(m[2] === ' hidden', m[1]).toBe(m[1] !== first);
  });
});
