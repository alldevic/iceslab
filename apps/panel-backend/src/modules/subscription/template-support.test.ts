import { describe, it, expect } from 'vitest';
import {
  DOORS,
  FORMAT_DOORS,
  PROTOCOL_NAMES,
  SUBSCRIPTION_TRANSPORT_FORMATS,
  TEMPLATE_FORMATS,
  TEMPLATE_TRANSPORT,
  TEMPLATE_TYPES,
  TRANSPORT_SUPPORT,
  XRAY_TRANSPORT_COLUMNS,
  XRAY_TRANSPORT_SUBPROTOCOLS,
  doorOf,
  templateCarries,
  templateDoors,
} from '@iceslab/shared';

/**
 * A-236 step 1: what each template type carries, doors and transports, from
 * the one table beside the transport table. Composition: a protocol, a door
 * or a type added without its answer here fails, by name.
 */
describe('the template matrix', () => {
  it('answers every door for every type, with a reason for every gap', () => {
    for (const type of TEMPLATE_TYPES) {
      const doors = templateDoors(type);
      for (const door of DOORS) {
        const cell = doors[door];
        expect(cell, `${type}/${door}`).toBeDefined();
        if (!cell.carried) expect(['client-lacks-protocol', 'no-uri-standard', 'not-yet'], `${type}/${door}`).toContain(cell.why);
      }
    }
  });

  it('has a door for every protocol, so a new protocol reaches this matrix', () => {
    for (const protocol of PROTOCOL_NAMES) {
      if (protocol === 'xray') continue;
      expect(DOORS as readonly string[], `protocol ${protocol} has no door`).toContain(doorOf({ protocol }));
    }
  });

  it('gives every type a transport row, and every transport row a cell per subprotocol and column', () => {
    for (const type of TEMPLATE_TYPES) {
      expect(SUBSCRIPTION_TRANSPORT_FORMATS as readonly string[], type).toContain(TEMPLATE_TRANSPORT[type]);
      for (const sub of XRAY_TRANSPORT_SUBPROTOCOLS) {
        for (const col of XRAY_TRANSPORT_COLUMNS) {
          expect(TRANSPORT_SUPPORT[TEMPLATE_TRANSPORT[type]][sub][col], `${type}/${sub}/${col}`).toBeDefined();
        }
      }
    }
  });

  it('writes no door twice: a type with a format of its own reads that format', () => {
    for (const type of ['mihomo', 'singbox', 'xray-json', 'xray-json-array'] as const) {
      expect(templateDoors(type)).toBe(FORMAT_DOORS[TEMPLATE_FORMATS[type]]);
    }
  });

  it('Stash: vless with XHTTP and REALITY, no httpupgrade, no ShadowTLS (stash.wiki, 23.10)', () => {
    expect(templateCarries('stash', { door: 'vless', network: 'xhttp', xhttpMode: 'stream-one', securityLayer: 'default' })).toBe(true);
    expect(templateCarries('stash', { door: 'trojan', network: 'grpc', securityLayer: 'default' })).toBe(true);
    expect(templateCarries('stash', { door: 'vless', network: 'httpupgrade', securityLayer: 'tls' })).toBe(false);
    expect(templateCarries('stash', { door: 'vmess', network: 'xhttp', securityLayer: 'none' })).toBe(false);
    expect(templateCarries('stash', { door: 'shadowtls' })).toBe(false);
    expect(templateCarries('stash', { door: 'hysteria' })).toBe(true);
  });

  it('legacy Clash: no vless, no REALITY, trojan over TLS, nothing newer (clash.wiki, 23.10)', () => {
    expect(templateCarries('clash', { door: 'vless', network: 'raw', securityLayer: 'tls' })).toBe(false);
    expect(templateCarries('clash', { door: 'trojan', network: 'raw', securityLayer: 'default' })).toBe(false);
    expect(templateCarries('clash', { door: 'trojan', network: 'ws', securityLayer: 'tls' })).toBe(true);
    expect(templateCarries('clash', { door: 'vmess', network: 'grpc', securityLayer: 'none' })).toBe(true);
    expect(templateCarries('clash', { door: 'hysteria' })).toBe(false);
    expect(templateCarries('clash', { door: 'shadowsocks' })).toBe(true);
  });

  it('mihomo, sing-box and xray-json read their formats\' rows', () => {
    expect(templateCarries('mihomo', { door: 'vless', network: 'xhttp', securityLayer: 'default' })).toBe(true);
    expect(templateCarries('singbox', { door: 'vless', network: 'xhttp', securityLayer: 'default' })).toBe(false);
    expect(templateCarries('xray-json', { door: 'vmess', network: 'kcp', securityLayer: 'none' })).toBe(true);
    expect(templateCarries('xray-json-array', { door: 'hysteria' })).toBe(true);
    expect(templateCarries('xray-json', { door: 'hysteria' })).toBe(false);
  });
});
