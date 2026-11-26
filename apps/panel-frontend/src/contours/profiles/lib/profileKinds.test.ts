import { describe, expect, it } from 'vitest';
import { ENGINE_OPTIONS, XRAY_PLAIN_SUBPROTOCOLS } from '@iceslab/shared';
import { ENGINE_CHOICE_PROTOCOLS, PREVIEW_KINDS, PROFILE_KINDS, profileKindKey } from '@/contours/profiles/lib/profileKinds';
import { engineTabOf } from '@/contours/profiles/lib/protocolTiles';
import { defaults } from '@/contours/profiles/lib/profileDefaults';

describe('SOCKS5 и HTTP как виды профиля', () => {
  it('у каждого подпротокола из контракта ровно один вид, на xray и только native', () => {
    for (const sub of XRAY_PLAIN_SUBPROTOCOLS) {
      const kinds = PROFILE_KINDS.filter((k) => k.subprotocol === sub);
      expect(kinds).toHaveLength(1);
      expect(kinds[0]).toMatchObject({ protocol: 'xray', engine: 'native' });
    }
    // Сервер отказывает им на sing-box: близнеца `#singbox` быть не должно.
    expect(PROFILE_KINDS.filter((k) => k.subprotocol && k.engine === 'singbox')).toEqual([]);
  });

  it('лежат на полке Telegram, а vless остаётся на вкладке xray', () => {
    expect(engineTabOf('xray', 'native', 'socks')).toBe('telegram');
    expect(engineTabOf('xray', 'native', 'http')).toBe('telegram');
    expect(engineTabOf('xray', 'native', 'vless')).toBe('xray');
    expect(engineTabOf('xray', 'native')).toBe('xray');
    expect(engineTabOf('xray', 'singbox', 'vless')).toBe('singbox');
  });

  it('ключ выбора отличает их от vless на том же протоколе', () => {
    expect(profileKindKey('xray', 'native', 'socks')).toBe('socks5');
    expect(profileKindKey('xray', 'native', 'http')).toBe('http');
    expect(profileKindKey('xray', 'native', 'vless')).toBe('xray');
    expect(profileKindKey('xray', 'singbox', 'trojan')).toBe('xray#singbox');
  });

  it('в предпросмотре остался только WEB', () => {
    expect(PREVIEW_KINDS.map((p) => p.key)).toEqual(['telegramweb']);
  });
});

/**
 * Mirror of the API's ENGINE_OPTIONS (in @iceslab/shared, which the backend
 * validates the engine against): the form offers a choice of core to exactly
 * the protocols the API gives more than one. A second core added on the API
 * without a form change fails here, and so does a choice offered for a protocol
 * with one core.
 */
describe('выбор ядра в форме и ENGINE_OPTIONS', () => {
  const several = Object.entries(ENGINE_OPTIONS)
    .filter(([, engines]) => engines.length > 1)
    .map(([protocol]) => protocol);

  it('ENGINE_CHOICE_PROTOCOLS: ровно протоколы API с более чем одним ядром', () => {
    expect([...ENGINE_CHOICE_PROTOCOLS].sort()).toEqual(several.sort());
  });

  it('видов у протокола столько, сколько у API ядер: один у протокола с одним ядром', () => {
    for (const [protocol, engines] of Object.entries(ENGINE_OPTIONS)) {
      const kinds = PROFILE_KINDS.filter((k) => k.protocol === protocol && !k.subprotocol);
      // mtg is MTProto's absence of an engine: a tile of its own that the API
      // lists nowhere, beside the one tile of mtprotoproxy.
      expect(kinds.length, protocol).toBe(protocol === 'mtproto' ? engines.length + 1 : engines.length);
    }
  });
});

describe('MTProto на mtprotoproxy', () => {
  it('своя плитка рядом с mtg, в той же вкладке Telegram', () => {
    expect(profileKindKey('mtproto', 'mtprotoproxy')).toBe('mtproto#mtprotoproxy');
    expect(profileKindKey('mtproto', 'native')).toBe('mtproto');
    const kind = PROFILE_KINDS.find((k) => k.key === 'mtproto#mtprotoproxy');
    expect(kind).toMatchObject({ protocol: 'mtproto', engine: 'mtprotoproxy' });
    expect(engineTabOf('mtproto', 'mtprotoproxy')).toBe('telegram');
  });

  it('профиль на mtprotoproxy открывается на своей плитке, на mtg остаётся без движка', () => {
    const values = defaults({ protocol: 'mtproto', engine: 'mtprotoproxy', config: {} } as never);
    expect(values.engine).toBe('mtprotoproxy');
    expect(defaults({ protocol: 'mtproto', engine: null, config: {} } as never).engine).toBe('native');
  });
});

describe('plain WireGuard as a kind of profile (9.3)', () => {
  it('one native kind, on the native shelf, with its own tile text', () => {
    const kinds = PROFILE_KINDS.filter((k) => k.protocol === 'wireguard');
    expect(kinds).toEqual([{ key: 'wireguard', protocol: 'wireguard', engine: 'native', label: 'WireGuard' }]);
    expect(engineTabOf('wireguard', 'native')).toBe('native');
    expect(profileKindKey('wireguard', 'native')).toBe('wireguard');
  });

  it('every kind has a tile label, hint and note', async () => {
    const { PROTOCOL_TILE_HINT, PROTOCOL_TILE_LABEL, PROTOCOL_TILE_NOTE } = await import('@/contours/profiles/lib/protocolTiles');
    for (const k of PROFILE_KINDS) {
      const key = k.key;
      expect(PROTOCOL_TILE_LABEL[key], `${key} label`).toBeTruthy();
      expect(PROTOCOL_TILE_HINT[key], `${key} hint`).toBeTruthy();
      expect(PROTOCOL_TILE_NOTE[key], `${key} note`).toBeTruthy();
    }
  });
});
