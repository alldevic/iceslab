import { describe, expect, it } from 'vitest';
import { buildTrojanRealityUri } from './trojan-uri.js';

const baseOpts = {
  password: 'cabc78ae-94e3-4a16-936a-133d059acfac',
  host: 'n1.example.com',
  port: 443,
  publicKey: 'fake-pubkey',
  shortId: 'abc123',
  sni: 'www.cloudflare.com',
  fingerprint: 'chrome',
  name: 'se-trojan-01',
};

describe('buildTrojanRealityUri', () => {
  it('uses trojan:// scheme with password as userinfo', () => {
    const uri = buildTrojanRealityUri(baseOpts);
    expect(uri.startsWith('trojan://')).toBe(true);
    // UUID should appear after scheme; encodeURIComponent leaves UUID chars as-is.
    expect(uri).toContain('@n1.example.com:443');
    expect(uri).toContain(`trojan://${baseOpts.password}@`);
  });

  it('includes REALITY query params (sans flow)', () => {
    const uri = buildTrojanRealityUri(baseOpts);
    expect(uri).toContain('type=raw');
    expect(uri).toContain('security=reality');
    expect(uri).toContain('pbk=fake-pubkey');
    expect(uri).toContain('sid=abc123');
    expect(uri).toContain('sni=www.cloudflare.com');
    expect(uri).toContain('fp=chrome');
    expect(uri).not.toContain('flow=');
    expect(uri).not.toContain('encryption=');
  });

  it('appends fragment from name', () => {
    const uri = buildTrojanRealityUri(baseOpts);
    expect(uri.endsWith('#se-trojan-01')).toBe(true);
  });

  it('emits path/host on httpupgrade', () => {
    const uri = buildTrojanRealityUri({
      ...baseOpts,
      network: 'httpupgrade',
      path: '/u',
      hostHeader: 'cdn.example.com',
    });
    expect(uri).toContain('type=httpupgrade');
    expect(uri).toContain('path=%2Fu');
    expect(uri).toContain('host=cdn.example.com');
  });

  it('emits headerType on kcp', () => {
    const uri = buildTrojanRealityUri({ ...baseOpts, network: 'kcp' });
    expect(uri).toContain('type=kcp');
    expect(uri).toContain('headerType=none');
  });

  it('emits serviceName on grpc', () => {
    const uri = buildTrojanRealityUri({
      ...baseOpts,
      network: 'grpc',
      serviceName: 'GunSvc',
    });
    expect(uri).toContain('type=grpc');
    expect(uri).toContain('serviceName=GunSvc');
  });
});

describe('buildTrojanRealityUri IPv6', () => {
  it('brackets an IPv6 host', () => {
    expect(buildTrojanRealityUri({ ...baseOpts, host: '2001:db8::1' })).toContain('@[2001:db8::1]:443?');
  });
});
