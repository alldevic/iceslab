import { describe, expect, it } from 'vitest';
import { checkSniConsistency, resolveHostFields } from './host-fields.js';

// The point of this table is that a control the operator can see is a control
// that reaches the client. Each case below pins one protocol/transport shape
// against what the URI builders and formatters actually consume.

describe('resolveHostFields', () => {
  it('xray on raw: no path or Host header, they have nowhere to go', () => {
    const f = resolveHostFields('xray', { security: 'reality', network: 'raw' });
    expect(f.pathOverride.supported).toBe(false);
    expect(f.hostHeaderOverride.supported).toBe(false);
    expect(f.pathOverride.reason).toContain('raw');
  });

  it('xray on ws: path and Host header exist and inherit from the profile', () => {
    const f = resolveHostFields('xray', {
      security: 'reality',
      network: 'ws',
      path: '/download',
      host: 'cdn.example.com',
    });
    expect(f.pathOverride).toMatchObject({ supported: true, inherited: '/download' });
    expect(f.hostHeaderOverride).toMatchObject({
      supported: true,
      inherited: 'cdn.example.com',
    });
  });

  it('xray REALITY: SNI inherits the first served name', () => {
    const f = resolveHostFields('xray', {
      security: 'reality',
      realityServerNames: ['www.microsoft.com', 'www.bing.com'],
    });
    expect(f.sniOverride).toMatchObject({
      supported: true,
      inherited: 'www.microsoft.com',
    });
  });

  it('xray TLS: SNI inherits the certificate name instead', () => {
    const f = resolveHostFields('xray', {
      security: 'tls',
      tlsServerName: 'vpn.example.com',
      realityServerNames: ['www.microsoft.com'],
    });
    expect(f.sniOverride.inherited).toBe('vpn.example.com');
  });

  it('xray self-steal: SNI stays offered but inherits nothing, the value is per-node', () => {
    const f = resolveHostFields('xray', {
      security: 'reality',
      realityMode: 'self-steal',
      realityServerNames: ['ignored.example.com'],
    });
    expect(f.sniOverride.supported).toBe(true);
    expect(f.sniOverride.inherited).toBeNull();
    expect(f.sniOverride.reason).toContain('node');
  });

  it('xray without TLS: no fingerprint to fake', () => {
    const f = resolveHostFields('xray', { security: 'none', network: 'ws' });
    expect(f.fingerprintOverride.supported).toBe(false);
    // SNI survives: a CDN may still terminate TLS in front of this inbound.
    expect(f.sniOverride.supported).toBe(true);
  });

  it.each([
    ['hysteria', {}],
    ['naive', {}],
    ['shadowsocks', {}],
    ['mtproto', {}],
    ['mieru', {}],
    ['amneziawg', {}],
    ['wireguard', {}],
  ])('%s: every TLS/transport override is dead and says why', (protocol, cfg) => {
    const f = resolveHostFields(protocol, cfg);
    for (const name of [
      'sniOverride',
      'hostHeaderOverride',
      'pathOverride',
      'fingerprintOverride',
      'alpn',
      'allowInsecure',
      'securityLayer',
    ]) {
      expect(f[name].supported, `${protocol}.${name}`).toBe(false);
      expect(f[name].reason, `${protocol}.${name}`).toBeTruthy();
    }
  });

  it('naive inherits its dial address from the profile hostname', () => {
    const f = resolveHostFields('naive', { hostname: 'vpn.example.com' });
    expect(f.addressOverride).toMatchObject({
      supported: true,
      inherited: 'vpn.example.com',
    });
  });

  it('universal fields survive on every protocol, including unknown ones', () => {
    for (const protocol of ['xray', 'amneziawg', 'something-new']) {
      const f = resolveHostFields(protocol, {});
      expect(f.addressOverride.supported, protocol).toBe(true);
      expect(f.portOverride.supported, protocol).toBe(true);
      expect(f.remark.supported, protocol).toBe(true);
      expect(f.disableForFormats.supported, protocol).toBe(true);
    }
  });
});

describe('checkSniConsistency', () => {
  const reality = {
    protocol: 'xray',
    config: { security: 'reality', realityServerNames: ['www.microsoft.com'] },
  };

  it('rejects an SNI the inbound will not answer for', () => {
    const v = checkSniConsistency({
      ...reality,
      sniOverride: 'typo.example.com',
      securityLayer: 'default',
    });
    expect(v).toEqual({ ok: false, expected: ['www.microsoft.com'] });
  });

  it('accepts a served name', () => {
    expect(
      checkSniConsistency({
        ...reality,
        sniOverride: 'www.microsoft.com',
        securityLayer: 'default',
      }),
    ).toBeNull();
  });

  it('leaves a CDN-fronted host alone: there the SNI is the CDN name', () => {
    expect(
      checkSniConsistency({ ...reality, sniOverride: 'cdn.example.com', securityLayer: 'tls' }),
    ).toBeNull();
  });

  it('leaves self-steal alone: the served name lives on the node', () => {
    expect(
      checkSniConsistency({
        protocol: 'xray',
        config: {
          security: 'reality',
          realityMode: 'self-steal',
          realityServerNames: ['www.microsoft.com'],
        },
        sniOverride: 'node-1.example.com',
        securityLayer: 'default',
      }),
    ).toBeNull();
  });

  it('ignores protocols that have no REALITY to contradict', () => {
    expect(
      checkSniConsistency({
        protocol: 'hysteria',
        config: {},
        sniOverride: 'anything.example.com',
        securityLayer: 'default',
      }),
    ).toBeNull();
  });

  it('says nothing when the host sets no SNI of its own', () => {
    expect(
      checkSniConsistency({ ...reality, sniOverride: null, securityLayer: 'default' }),
    ).toBeNull();
  });
});
