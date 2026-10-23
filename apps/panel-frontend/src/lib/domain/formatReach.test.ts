import { describe, expect, it } from 'vitest';
import { transportServed } from '@iceslab/shared';
import { clientSecurityLayer } from '@iceslab/shared';
import { clientsLeftOut, hostsMaySecureOtherwise } from '@/lib/domain/formatReach';

describe('clientsLeftOut (A-224), по общей таблице shared', () => {
  it('vless + REALITY + xhttp: sing-box, Surge, Quantumult X, Loon', () => {
    expect(clientsLeftOut({ subprotocol: 'vless', network: 'xhttp', security: 'reality' })).toEqual([
      'singbox',
      'surge',
      'quantumultx',
      'loon',
    ]);
  });

  it('vmess + ws + TLS: никого', () => {
    expect(clientsLeftOut({ subprotocol: 'vmess', network: 'ws', security: 'tls' })).toEqual([]);
  });

  it('vless + ws + TLS: только Surge, у которого VLESS нет вовсе (таблица: surge.vless целиком skipped)', () => {
    expect(clientsLeftOut({ subprotocol: 'vless', network: 'ws', security: 'tls' })).toEqual(['surge']);
  });

  it('ответ сверяется с функцией shared, а не с копией ячеек', () => {
    for (const network of ['raw', 'ws', 'grpc', 'xhttp', 'httpupgrade', 'kcp']) {
      for (const security of ['reality', 'tls', 'none']) {
        const out = clientsLeftOut({ subprotocol: 'trojan', network, security });
        const layer = security === 'reality' ? 'default' : security;
        expect(out.includes('singbox')).toBe(!transportServed('singbox', { subprotocol: 'trojan', network, securityLayer: layer }));
        expect(out.includes('xrayjson')).toBe(!transportServed('xrayjson', { subprotocol: 'trojan', network, securityLayer: layer }));
        expect(out.includes('v2rayn')).toBe(!transportServed('trojan-link', { subprotocol: 'trojan', network, securityLayer: layer }));
      }
    }
  });

  it('socks и http не спрашиваются: строки нет', () => {
    expect(clientsLeftOut({ subprotocol: 'socks', network: 'raw', security: 'none' })).toEqual([]);
    expect(clientsLeftOut({ subprotocol: 'http', network: 'raw', security: 'none' })).toEqual([]);
  });
});

describe('защита хоста против защиты профиля (замечание AUDT к A-224)', () => {
  const profile = { subprotocol: 'trojan', network: 'ws', security: 'reality' };

  it('REALITY-профиль, хост на TLS, ws: на хосте Surge и QX не названы, на профиле названы', () => {
    const onProfile = clientsLeftOut(profile);
    expect(onProfile).toContain('surge');
    expect(onProfile).toContain('quantumultx');
    const onHost = clientsLeftOut({ ...profile, hostSecurity: 'tls' });
    expect(onHost).not.toContain('surge');
    expect(onHost).not.toContain('quantumultx');
  });

  it('хост без своей защиты (default) считает по профилю', () => {
    expect(clientsLeftOut({ ...profile, hostSecurity: 'default' })).toEqual(clientsLeftOut(profile));
  });

  it('A-230: слой из shared, как у подписки: хост tls/none сильнее, vmess с REALITY и без security даёт none', () => {
    const at = (security: string, subprotocol: string, hostSecurity?: 'default' | 'tls' | 'none') =>
      clientsLeftOut({ subprotocol, network: 'ws', security, hostSecurity });
    // Списки клиентов равны спискам по слою из общей функции, не по своей копии.
    expect(at('reality', 'vless', 'tls')).toEqual(at('tls', 'vless'));
    expect(at('tls', 'vless', 'none')).toEqual(at('none', 'vless'));
    expect(clientSecurityLayer({ subprotocol: 'vmess', security: 'reality' })).toBe('none');
    expect(clientSecurityLayer({ subprotocol: 'vmess', security: null })).toBe('none');
    expect(clientSecurityLayer({ subprotocol: 'vless', security: 'reality' }, 'tls')).toBe('tls');
    expect(clientSecurityLayer({ subprotocol: 'trojan', security: 'none' }, 'default')).toBe('none');
  });

  it('оговорка на профиле: только если хост переопределяет; список не пришёл: оговорка остаётся', () => {
    expect(hostsMaySecureOtherwise([{ securityLayer: 'default' }])).toBe(false);
    expect(hostsMaySecureOtherwise([{ securityLayer: 'default' }, { securityLayer: 'tls' }])).toBe(true);
    expect(hostsMaySecureOtherwise([])).toBe(false);
    expect(hostsMaySecureOtherwise(null)).toBe(true);
  });
});
