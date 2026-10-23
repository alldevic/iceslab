import { describe, expect, it } from 'vitest';
import { transportServed } from '@iceslab/shared';
import { clientsLeftOut } from '@/contours/profiles/lib/formatReach';

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
        expect(out.includes('v2rayn')).toBe(!transportServed('trojan-link', { subprotocol: 'trojan', network, securityLayer: layer }));
      }
    }
  });

  it('socks и http не спрашиваются: строки нет', () => {
    expect(clientsLeftOut({ subprotocol: 'socks', network: 'raw', security: 'none' })).toEqual([]);
    expect(clientsLeftOut({ subprotocol: 'http', network: 'raw', security: 'none' })).toEqual([]);
  });
});
