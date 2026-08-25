import { describe, expect, it } from 'vitest';
import { buildWireguardClientConfig } from './wgconf.js';

const base = {
  privateKey: 'cliPriv64',
  allowedIp: '10.77.77.5/32',
  serverPublicKey: 'srvPub64',
  host: 'wg.example.com',
  port: 51820,
};

describe('buildWireguardClientConfig', () => {
  it('emits an [Interface] + [Peer] pair a stock wg-quick accepts', () => {
    const out = buildWireguardClientConfig(base);
    expect(out).toBe(
      [
        '[Interface]',
        'PrivateKey = cliPriv64',
        'Address = 10.77.77.5/32',
        '',
        '[Peer]',
        'PublicKey = srvPub64',
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'Endpoint = wg.example.com:51820',
        'PersistentKeepalive = 25',
        '',
      ].join('\n'),
    );
  });

  it('carries no AmneziaWG directive whatsoever', () => {
    const out = buildWireguardClientConfig(base);
    for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      expect(out).not.toContain(key);
    }
  });

  it('defaults to a full tunnel and takes an explicit split list', () => {
    expect(buildWireguardClientConfig(base)).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    // CIDR AllowedIPs is WireGuard's only split mechanism; the generator has to
    // pass a caller-supplied list through verbatim, in order.
    const split = buildWireguardClientConfig({
      ...base,
      clientAllowedIps: ['1.0.0.0/8', '8.8.8.8/32'],
    });
    expect(split).toContain('AllowedIPs = 1.0.0.0/8, 8.8.8.8/32');
  });

  it('emits DNS only when pushed, and honours a keepalive override', () => {
    expect(buildWireguardClientConfig(base)).not.toContain('DNS');
    const withDns = buildWireguardClientConfig({
      ...base,
      dns: ['1.1.1.1', '8.8.8.8'],
      persistentKeepalive: 15,
    });
    expect(withDns).toContain('DNS = 1.1.1.1, 8.8.8.8');
    expect(withDns).toContain('PersistentKeepalive = 15');
  });
});
