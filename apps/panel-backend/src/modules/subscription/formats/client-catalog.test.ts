// Invariants of the catalogue itself, as data.
//
// Both install surfaces project this table, so a bad row is not a rendering
// bug in one of them — it is the same wrong promise made twice. These are the
// properties that cannot be seen by reading one entry at a time.

import { describe, expect, it } from 'vitest';
import {
  APPS,
  PLATFORM_ORDER,
  PROTOCOL_DELIVERY,
  appsForPlatform,
  deeplinkHref,
} from './client-catalog.js';

const ALL_PROTOCOLS = Object.keys(PROTOCOL_DELIVERY) as (keyof typeof PROTOCOL_DELIVERY)[];

describe('the client catalogue', () => {
  it('states a delivery channel for every protocol the panel can serve', () => {
    // The Record is exhaustive at the type level; this catches the other half —
    // a protocol given a channel nobody renders.
    const rendered = new Set(['subscription', 'per-node-file', 'per-endpoint-link']);
    for (const p of ALL_PROTOCOLS) expect(rendered, p).toContain(PROTOCOL_DELIVERY[p]);
  });

  it('offers no app on a platform it does not list', () => {
    for (const platform of PLATFORM_ORDER) {
      for (const app of appsForPlatform(platform, ALL_PROTOCOLS)) {
        expect(app.platforms, `${app.name} on ${platform}`).toContain(platform);
      }
    }
  });

  it('links only to destinations for platforms the app actually runs on', () => {
    // An install link under a platform the app is not listed for is dead
    // weight at best; at worst it is a buyer sent to an app that will not run.
    for (const app of APPS) {
      for (const platform of Object.keys(app.install ?? {})) {
        expect(app.platforms, `${app.name}: install link for ${platform}`).toContain(platform);
      }
    }
  });

  it('links only to http(s), never to a scheme a browser will not open', () => {
    for (const app of APPS) {
      for (const [platform, url] of Object.entries(app.install ?? {})) {
        expect(url, `${app.name}/${platform}`).toMatch(/^https:\/\//);
      }
    }
  });

  it('pins no install link to a specific release', () => {
    // The shop's own guide ships `v2rayNG_2.0.9.apk` and versioned .deb/.rpm
    // URLs, which are stale the day upstream tags. A GitHub `/releases/latest`
    // is fine; a `/releases/download/<tag>/` is the thing being refused.
    for (const app of APPS) {
      for (const [platform, url] of Object.entries(app.install ?? {})) {
        expect(url, `${app.name}/${platform} pins a release`).not.toContain('/releases/download/');
      }
    }
  });

  it('gives every app an import path its own action can actually deliver', () => {
    // A deep link is only meaningful for a client that fetches the
    // subscription; a file action only for a protocol that produces files.
    for (const app of APPS) {
      const channels = new Set(app.protocols.map((p) => PROTOCOL_DELIVERY[p]));
      if (app.action.kind === 'deeplink' || app.action.kind === 'manual') {
        expect(channels, `${app.name} takes the subscription`).toContain('subscription');
      }
      if (app.action.kind === 'endpoint-link') {
        expect(channels, `${app.name} takes one endpoint's link`).toContain('per-endpoint-link');
      }
      if (['awg-vpn', 'awg-conf', 'wg-conf', 'download'].includes(app.action.kind)) {
        expect(channels, `${app.name} takes a file`).toContain('per-node-file');
      }
    }
  });

  it('declares a format only for the clients that fetch one', () => {
    for (const app of APPS) {
      if (!app.format) continue;
      const channels = new Set(app.protocols.map((p) => PROTOCOL_DELIVERY[p]));
      expect(channels, `${app.name} declares a format but fetches no subscription`).toContain(
        'subscription',
      );
    }
  });

  it('quotes a price only where a store both carries the app and sells it', () => {
    // A price is a fact about a storefront, so it can only sit where there IS
    // one. Two ways to get this wrong, and both make the page say something
    // impossible: a price on a platform whose store does not carry the app at
    // all, and a price on Linux or a router, where nobody is buying anything.
    const STOREFRONTS = new Set(['ios', 'macos', 'appletv', 'android', 'androidtv']);
    for (const app of APPS) {
      for (const platform of Object.keys(app.storePrice ?? {})) {
        expect(STOREFRONTS, `${app.name}: price on ${platform}, which has no store`).toContain(
          platform,
        );
        expect(
          app.storeGap?.[platform as keyof typeof app.storeGap],
          `${app.name}: priced on ${platform}, where the store does not carry it`,
        ).toBeUndefined();
        expect(
          app.install?.[platform as keyof typeof app.install],
          `${app.name}: priced on ${platform} with no checked link to buy it from`,
        ).toBeDefined();
        expect(app.platforms, `${app.name}: price for ${platform}`).toContain(platform);
      }
    }
  });

  it('quotes the price in the currency the buyer is charged', () => {
    // Measured against the RUSSIAN storefront (2026-09-16), because that is the
    // one our buyers open. The US number for the same listing is $2.99 and
    // would be a different, unpayable claim.
    for (const app of APPS) {
      for (const [platform, price] of Object.entries(app.storePrice ?? {})) {
        expect(price, `${app.name}/${platform}`).toContain('₽');
      }
    }
  });

  it('builds a deep link that carries the subscription URL', () => {
    const sub = 'https://panel.example/sub/tok';
    for (const app of APPS) {
      if (app.action.kind !== 'deeplink') continue;
      const href = deeplinkHref(app.action.scheme, sub);
      // Either the URL rides verbatim, or it is encoded into the link — the
      // Shadowrocket form base64s it. What must never happen is a deep link
      // that mentions neither.
      const carries =
        href.includes(sub) ||
        href.includes(encodeURIComponent(sub)) ||
        href.includes(Buffer.from(sub, 'utf8').toString('base64'));
      expect(carries, `${app.name}: ${href}`).toBe(true);
    }
  });
});
