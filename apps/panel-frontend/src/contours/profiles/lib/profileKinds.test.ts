import { describe, expect, it } from 'vitest';
import { ENGINE_OPTIONS, XRAY_PLAIN_SUBPROTOCOLS } from '@iceslab/shared';
import { ENGINE_CHOICE_PROTOCOLS, PREVIEW_KINDS, PROFILE_KINDS, profileKindKey } from '@/contours/profiles/lib/profileKinds';
import { engineTabOf } from '@/contours/profiles/lib/protocolTiles';

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
      expect(kinds.length, protocol).toBe(engines.length);
    }
  });
});
