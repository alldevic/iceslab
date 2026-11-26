import { describe, it, expect } from 'vitest';
import { CLIENTS, PLATFORM_IDS, XRAY_SUBPROTOCOLS, doorOf, formatCarries, type ProtocolName } from '@iceslab/shared';
import { APPS, appFormat, type AppDef } from './subscription.page-apps.js';
import { appsFor } from './subscription.page.js';

/** The doors a protocol's endpoints come through. xray is the one protocol with
 *  several (the two Telegram doors are not a client's business here). */
function doorsOf(p: ProtocolName) {
  return p === 'xray' ? [...XRAY_SUBPROTOCOLS] : [doorOf({ protocol: p })];
}

/** Does this entry's format carry the protocol at all, by the table the files go through? */
function carries(a: AppDef, p: ProtocolName): boolean {
  const format = appFormat(a);
  if (!format) return true; // a per-node handout or a recipe: no subscription file
  return doorsOf(p).some((d) => formatCarries(format, d).carried);
}

describe('the app registry against what each format carries', () => {
  // Hiddify claims amneziawg although its `singbox` answer does not carry it. It
  // predates the table and may be deliberate (the app has its own AWG support),
  // so it is left as the base has it and named here until somebody decides.
  const KNOWN = new Set(['Hiddify: amneziawg']);

  it('claims no protocol that the entry\'s format does not carry', () => {
    const wrong = APPS.flatMap((a) => a.protocols.filter((p) => !carries(a, p)).map((p) => `${a.name}: ${p}`));
    expect(wrong.filter((w) => !KNOWN.has(w))).toEqual([]);
  });

  // mieru and naive have a share link, but no client of the `plain` kind was
  // checked to read the scheme (decision of 26.11.2026), so they are claimed by
  // the formats that carry them in a whole config only.
  it('claims mieru and naive for no entry of the `plain` format', () => {
    const plain = APPS.filter((a) => appFormat(a) === 'plain');
    expect(plain.length).toBeGreaterThan(0);
    for (const a of plain) {
      expect(a.protocols, a.name).not.toContain('mieru');
      expect(a.protocols, a.name).not.toContain('naive');
    }
  });

  it('claims every protocol its format carries among tuic, anytls, shadowtls and (non-plain) mieru', () => {
    for (const a of APPS) {
      const format = appFormat(a);
      if (!format || format === 'plain') continue;
      for (const p of ['tuic', 'anytls', 'shadowtls', 'mieru'] as const) {
        if (carries(a, p)) expect(a.protocols, `${a.name} ${p}`).toContain(p);
      }
    }
  });

  it.each(['tuic', 'anytls', 'shadowtls', 'mieru'] as const)(
    'leaves no platform with an empty tab for a %s-only subscriber when a client of a fitting format is there',
    (p) => {
      for (const platform of PLATFORM_IDS) {
        const fitting = APPS.filter((a) => a.platforms.includes(platform) && appFormat(a) && carries(a, p) && !(p === 'mieru' && appFormat(a) === 'plain'));
        if (fitting.length === 0) continue;
        expect(appsFor(platform, [p], false, false).length, `${p} on ${platform}`).toBeGreaterThan(0);
      }
    },
  );

  it('has a client for each of those four on at least one platform', () => {
    for (const p of ['tuic', 'anytls', 'shadowtls', 'mieru'] as const) {
      expect(APPS.some((a) => appFormat(a) && carries(a, p)), p).toBe(true);
    }
  });

  it('keeps every entry backed by a catalog client of its own name and platforms', () => {
    for (const a of APPS) {
      expect(a.client, a.name).toBeDefined();
      const c = CLIENTS[a.client!];
      expect(a.name).toBe(c.name);
      for (const pl of a.platforms) expect(c.platforms as readonly string[], `${a.name} ${pl}`).toContain(pl);
    }
  });

  it('shows V2Box on iOS only, while the catalog keeps all three platforms for recognising it', () => {
    const v2box = APPS.filter((a) => a.client === 'v2box');
    expect(v2box).toHaveLength(1);
    expect(v2box[0].platforms).toEqual(['ios']);
    expect(CLIENTS.v2box.platforms).toEqual(['ios', 'macos', 'android']);
  });
});

describe('the availability fields of the catalog', () => {
  it('sit on Apple platforms the client is on, and the price only where it is a price', () => {
    const apple = ['ios', 'macos', 'appletv'];
    for (const [id, c] of Object.entries(CLIENTS) as [string, (typeof CLIENTS)[keyof typeof CLIENTS]][]) {
      const d = c as { platforms: readonly string[]; storeGap?: object; storePrice?: Record<string, string> };
      for (const k of [...Object.keys(d.storeGap ?? {}), ...Object.keys(d.storePrice ?? {})]) {
        expect(apple, `${id} ${k}`).toContain(k);
        expect(d.platforms, `${id} ${k}`).toContain(k);
      }
      for (const price of Object.values(d.storePrice ?? {})) expect(price).toMatch(/\d/);
    }
  });

  it('are read from CLIENTS: V2Box is out of the Russian store, Shadowrocket costs money', () => {
    expect(CLIENTS.v2box.storeGap).toEqual({ ios: 'ru-storefront' });
    expect(CLIENTS.shadowrocket.storePrice).toEqual({ ios: '249 ₽', appletv: '249 ₽' });
  });
});
