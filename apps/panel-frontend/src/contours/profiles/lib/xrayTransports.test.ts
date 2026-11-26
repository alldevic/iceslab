import { describe, expect, it } from 'vitest';
import {
  FLOW_COMPATIBLE_TRANSPORTS,
  REALITY_COMPATIBLE_TRANSPORTS,
  XRAY_TRANSPORTS,
  singboxXrayPatch,
  transportAllowedUnder,
} from '@/contours/profiles/lib/xrayTransports';

const v = (over: Partial<Parameters<typeof singboxXrayPatch>[0]>) => ({
  protocol: 'xray',
  engine: 'singbox' as const,
  xrayNetwork: 'raw',
  xraySecurity: 'reality',
  xrayRealityMode: 'steal-others',
  ...over,
});

describe('singboxXrayPatch: xray на sing-box только REALITY steal-others по raw', () => {
  it('уже подходит: править нечего', () => {
    expect(singboxXrayPatch(v({}))).toEqual({});
  });

  it('пришли с плитки xray с xhttp, TLS и self-steal: всё возвращается к допустимому', () => {
    expect(singboxXrayPatch(v({ xrayNetwork: 'xhttp', xraySecurity: 'tls', xrayRealityMode: 'self-steal' }))).toEqual({
      xrayNetwork: 'raw',
      xraySecurity: 'reality',
      xrayRealityMode: 'steal-others',
    });
  });

  it('на ядре xray и у других протоколов не трогается ничего', () => {
    expect(singboxXrayPatch(v({ engine: 'native', xrayNetwork: 'xhttp' }))).toEqual({});
    expect(singboxXrayPatch(v({ protocol: 'hysteria', xrayNetwork: 'xhttp' }))).toEqual({});
  });
});

describe('singboxXrayPatch: ручки REALITY, которых у sing-box нет', () => {
  it('xver и лимиты fallback выключаются при переходе на sing-box, на xray остаются', () => {
    const knobs = { xrayRealityXver: 1 as const, xrayRealityLimitFallbackUpload: 1000, xrayRealityLimitFallbackDownload: 2000 };
    expect(singboxXrayPatch(v({ engine: 'singbox', ...knobs }))).toMatchObject({
      xrayRealityXver: 0,
      xrayRealityLimitFallbackUpload: 0,
      xrayRealityLimitFallbackDownload: 0,
    });
    expect(singboxXrayPatch(v({ engine: 'native', ...knobs }))).toEqual({});
  });
});

describe('transportAllowedUnder: REALITY несёт raw / xhttp / grpc', () => {
  it('REALITY: ws, httpupgrade и kcp недопустимы, остальные да', () => {
    expect(REALITY_COMPATIBLE_TRANSPORTS).toEqual(['raw', 'xhttp', 'grpc']);
    const refused = XRAY_TRANSPORTS.map((t) => t.value).filter((n) => !transportAllowedUnder('reality', n));
    expect(refused.sort()).toEqual(['httpupgrade', 'kcp', 'ws']);
  });

  it('TLS и none отдают все шесть транспортов', () => {
    for (const sec of ['tls', 'none']) {
      for (const t of XRAY_TRANSPORTS) expect(transportAllowedUnder(sec, t.value), `${sec} ${t.value}`).toBe(true);
    }
  });

  it('Vision: raw и xhttp', () => {
    expect(FLOW_COMPATIBLE_TRANSPORTS).toEqual(['raw', 'xhttp']);
  });
});
