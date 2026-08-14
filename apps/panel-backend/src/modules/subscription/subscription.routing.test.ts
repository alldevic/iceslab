import { describe, expect, it } from 'vitest';
import { resolveSquadRouting, expandEndpointUris } from './subscription.service.js';
import type { SubscriptionEndpoint } from './subscription.formats.js';

// R3-a - the per-squad routing merge rule (the one design decision in R3-a).
describe('resolveSquadRouting', () => {
  it('inherits (null) when no squad overrides', () => {
    expect(resolveSquadRouting([null, null])).toBe(null);
    expect(resolveSquadRouting([])).toBe(null);
  });

  it('uses the single override', () => {
    expect(resolveSquadRouting([null, 'ru-split'])).toBe('ru-split');
    expect(resolveSquadRouting(['proxy-all'])).toBe('proxy-all');
    // H2 - cn-split resolves as a single override like any other preset.
    expect(resolveSquadRouting([null, 'cn-split'])).toBe('cn-split');
  });

  it('dedupes identical overrides', () => {
    expect(resolveSquadRouting(['ru-split', 'ru-split', null])).toBe('ru-split');
    expect(resolveSquadRouting(['cn-split', 'cn-split', null])).toBe('cn-split');
  });

  it('falls back to null on conflicting overrides', () => {
    expect(resolveSquadRouting(['ru-split', 'proxy-all'])).toBe(null);
    // H2 - cn-split conflicting with ru-split -> inherit (null).
    expect(resolveSquadRouting(['cn-split', 'ru-split'])).toBe(null);
  });

  it('ignores invalid/garbage preset values', () => {
    expect(resolveSquadRouting(['garbage', 'ru-split'])).toBe('ru-split');
    expect(resolveSquadRouting(['garbage', 'also-bad'])).toBe(null);
  });
});

// R3 - the effective-preset precedence chain resolved in subscription.routes.ts.
// Mirrors the exact `??` expression there:
//   query.routing ?? userRoutingPreset ?? squadRoutingPreset ?? settings.routingPreset
// Kept as a pure expression test so the precedence ordering is pinned even
// though the resolution itself lives inline in the route handler.
describe('routing-preset precedence (R1a + R3-a + R3)', () => {
  type Preset = 'proxy-all' | 'ru-split' | 'cn-split';
  function resolve(
    query: Preset | undefined,
    user: Preset | null,
    squad: Preset | null,
    global: Preset,
  ): Preset {
    return query ?? user ?? squad ?? global;
  }

  it('?routing= query wins over everything', () => {
    expect(resolve('proxy-all', 'ru-split', 'ru-split', 'ru-split')).toBe('proxy-all');
  });

  it('per-user override wins over squad and global', () => {
    expect(resolve(undefined, 'ru-split', 'proxy-all', 'proxy-all')).toBe('ru-split');
  });

  it('squad override wins over global when user has no override', () => {
    expect(resolve(undefined, null, 'ru-split', 'proxy-all')).toBe('ru-split');
  });

  it('falls back to the global setting when neither user nor squad set', () => {
    expect(resolve(undefined, null, null, 'ru-split')).toBe('ru-split');
  });

  it('defaults to proxy-all all the way down', () => {
    expect(resolve(undefined, null, null, 'proxy-all')).toBe('proxy-all');
  });
});

// A4: plain / base64 URI expansion for balancer-cascade exits.
describe('expandEndpointUris', () => {
  const uuid = '84a8029e-b874-4418-8cec-a7da9af31157';
  const entry: SubscriptionEndpoint = {
    protocol: 'xray',
    nodeName: 'ru-entry',
    host: 'ru.example.com',
    port: 443,
    uuid,
    publicKey: 'pk',
    shortId: 'abc',
    sni: 'www.cloudflare.com',
    flow: 'xtls-rprx-vision',
    fingerprint: 'chrome',
    uri: `vless://${uuid}@ru.example.com:443?security=reality&pbk=pk&sid=abc#ru-entry`,
  };

  it('returns the single original URI when there are no cascade exits', () => {
    expect(expandEndpointUris(entry)).toEqual([entry.uri]);
  });

  it('expands one re-tagged URI per profile, remark = profile label', () => {
    const out = expandEndpointUris({
      ...entry,
      cascadeExits: [
        { label: 'de exit', tag: 1 },
        { label: 'nl', tag: 2 },
        { label: 'de exit · Без рекламы', tag: 257 }, // ad-split policy band -> 0101
      ],
    });
    expect(out).toEqual([
      'vless://84a8029e-b874-0001-8cec-a7da9af31157@ru.example.com:443?security=reality&pbk=pk&sid=abc#de%20exit',
      'vless://84a8029e-b874-0002-8cec-a7da9af31157@ru.example.com:443?security=reality&pbk=pk&sid=abc#nl',
      `vless://84a8029e-b874-0101-8cec-a7da9af31157@ru.example.com:443?security=reality&pbk=pk&sid=abc#${encodeURIComponent('de exit · Без рекламы')}`,
    ]);
  });

  it('suffixes profile remarks with the host remark on a multi-host entry', () => {
    // Only reached when the entry binding has more than one host: several
    // hosts on one entry produce the same set of ways out, so without the
    // suffix the client would list the same string twice. The caller decides
    // (subscription.service passes hostRemark only when hosts.length > 1),
    // which is why a single-host entry no longer glues its host name onto
    // every profile.
    const out = expandEndpointUris({
      ...entry,
      hostRemark: 'test 2',
      cascadeExits: [
        { label: 'first way out', tag: 1 },
        { label: 'second way out', tag: 2 },
      ],
    });
    expect(out[0]!.endsWith(`#${encodeURIComponent('first way out · test 2')}`)).toBe(true);
    expect(out[1]!.endsWith(`#${encodeURIComponent('second way out · test 2')}`)).toBe(true);
  });

  it('leaves the profile label alone when the entry has a single host', () => {
    // The regression: a client read "balancer · SE · ru-01-xhttp-reality",
    // the way out followed by our internal host name, on an entry that had
    // exactly one host and therefore nothing to disambiguate.
    const out = expandEndpointUris({
      ...entry,
      hostRemark: undefined,
      cascadeExits: [{ label: '🇸🇪 balancer · SE', tag: 1 }],
    });
    expect(out[0]!.endsWith(`#${encodeURIComponent('🇸🇪 balancer · SE')}`)).toBe(true);
  });

  it('does not re-tag vmess (UUID is not in the userinfo)', () => {
    const vmess: SubscriptionEndpoint = {
      ...entry,
      subprotocol: 'vmess',
      uri: 'vmess://eyJ2IjoiMiJ9',
      cascadeExits: [{ label: 'de', tag: 1 }],
    };
    expect(expandEndpointUris(vmess)).toEqual(['vmess://eyJ2IjoiMiJ9']);
  });

  it('drops an endpoint with an empty URI', () => {
    expect(expandEndpointUris({ ...entry, uri: '' })).toEqual([]);
  });
});
