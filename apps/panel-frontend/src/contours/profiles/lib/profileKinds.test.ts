import { describe, expect, it } from 'vitest';
import { XRAY_PLAIN_SUBPROTOCOLS } from '@iceslab/shared';
import { PREVIEW_KINDS, PROFILE_KINDS, profileKindKey } from '@/contours/profiles/lib/profileKinds';
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

describe('MTProto на mtprotoproxy', () => {
  it('своя плитка рядом с mtg, в той же вкладке Telegram', () => {
    expect(profileKindKey('mtproto', 'mtprotoproxy')).toBe('mtproto#mtprotoproxy');
    expect(profileKindKey('mtproto', 'native')).toBe('mtproto');
    const kind = PROFILE_KINDS.find((k) => k.key === 'mtproto#mtprotoproxy');
    expect(kind).toMatchObject({ protocol: 'mtproto', engine: 'mtprotoproxy' });
    expect(engineTabOf('mtproto', 'mtprotoproxy')).toBe('telegram');
  });

  it('профиль на mtprotoproxy открывается на своей плитке', () => {
    const values = defaults({ protocol: 'mtproto', engine: 'mtprotoproxy', config: {} } as never);
    expect(values.engine).toBe('mtprotoproxy');
    expect(defaults({ protocol: 'mtproto', engine: null, config: {} } as never).engine).toBe('native');
  });
});
