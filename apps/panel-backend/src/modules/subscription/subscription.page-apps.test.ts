import { describe, it, expect } from 'vitest';
import {
  CLIENTS,
  PLATFORM_IDS,
  PROTOCOL_NAMES,
  FORMAT_NAMES,
  XRAY_SUBPROTOCOLS,
  doorOf,
  formatCarries,
  type ProtocolName,
} from '@iceslab/shared';
import { APPS, appFormat, deeplinkHref, type AppDef } from './subscription.page-apps.js';
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
  it('claims no protocol that the entry\'s format does not carry', () => {
    const wrong = APPS.flatMap((a) => a.protocols.filter((p) => !carries(a, p)).map((p) => `${a.name}: ${p}`));
    expect(wrong).toEqual([]);
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

describe('the registry invariants (what an entry may promise, held to the entry itself)', () => {
  // A file or a key handed per tunnel node, not a subscription link.
  const PER_NODE_PROTOCOLS: Partial<Record<AppDef['action']['kind'], ProtocolName[]>> = {
    'awg-vpn': ['amneziawg'],
    'awg-conf': ['amneziawg'],
    'wg-conf': ['wireguard'],
    download: ['amneziawg', 'wireguard'],
    outline: ['shadowsocks'],
  };

  it('links to https only, and to no page pinned to one release', () => {
    for (const a of APPS) {
      if (!a.site) continue;
      expect(a.site, a.name).toMatch(/^https:\/\//);
      expect(a.site, `${a.name} pins a release`).not.toContain('/releases/download/');
      expect(a.site, `${a.name} pins a version`).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it('never offers an entry on a platform its catalog client is not on', () => {
    for (const a of APPS) {
      const c = CLIENTS[a.client!];
      for (const pl of a.platforms) expect(c.platforms as readonly string[], `${a.name} on ${pl}`).toContain(pl);
    }
  });

  it('gives a deeplink or manual entry at least one protocol its format carries', () => {
    for (const a of APPS) {
      if (a.action.kind !== 'deeplink' && a.action.kind !== 'manual') continue;
      if (!appFormat(a)) {
        // A router recipe is a person pasting the link by hand: no format by design.
        if (a.platforms.every((pl) => pl === 'router')) continue;
        expect.fail(`${a.name} takes a subscription link but has no format`);
      }
      expect(a.protocols.some((p) => carries(a, p)), a.name).toBe(true);
    }
  });

  it('gives a per-node action only the tunnel (or Outline) protocols and no subscription format', () => {
    for (const a of APPS) {
      const allowed = PER_NODE_PROTOCOLS[a.action.kind];
      if (!allowed) continue;
      // Outline's own `outline` format is the per-node key, not a subscription.
      expect([undefined, 'outline'], `${a.name} has a per-node action and a subscription format`).toContain(appFormat(a));
      for (const p of a.protocols) expect(allowed, `${a.name}: ${p}`).toContain(p);
    }
  });

  it('puts the encoded subscription address into every deeplink scheme', () => {
    const sub = 'https://panel.example.com/sub/a b&c=d';
    const schemes = new Set(APPS.flatMap((a) => (a.action.kind === 'deeplink' ? [a.action.scheme] : [])));
    expect(schemes.size).toBeGreaterThan(0);
    for (const scheme of schemes) {
      const href = deeplinkHref(scheme, sub);
      const carried =
        href.includes(encodeURIComponent(sub)) ||
        href.includes(Buffer.from(sub, 'utf8').toString('base64')) ||
        // hiddify://, streisand://, happ://, v2raytun:// take the address whole.
        href.endsWith(sub);
      expect(carried, `${scheme}: ${href}`).toBe(true);
    }
  });

  // Carried by a format or handed per node, and so something a buyer could be
  // sent to a client for. Every one has an entry except what is named here.
  const NO_ENTRY: Partial<Record<ProtocolName, string>> = {
    naive: 'no client of the page was checked to take it (decision of 26.11.2026); the formats that carry it carry it in a whole config',
    mtproto: 'a Telegram proxy, not a subscription client: the page draws it as its own Telegram row',
  };

  it('has an entry for every protocol a format or a per-node handout carries', () => {
    const served = (p: ProtocolName) =>
      FORMAT_NAMES.some((f) => doorsOf(p).some((d) => formatCarries(f, d).carried)) ||
      Object.values(PER_NODE_PROTOCOLS).some((ps) => ps!.includes(p));
    const missing = PROTOCOL_NAMES.filter((p) => served(p) && !NO_ENTRY[p] && !APPS.some((a) => a.protocols.includes(p)));
    expect(missing).toEqual([]);
    for (const p of Object.keys(NO_ENTRY)) expect(APPS.some((a) => a.protocols.includes(p as ProtocolName)), `${p} is not an exception any more`).toBe(false);
  });
});
