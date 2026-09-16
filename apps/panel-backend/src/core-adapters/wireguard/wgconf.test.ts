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
        'AllowedIPs = 0.0.0.0/0',
        'Endpoint = wg.example.com:51820',
        'PersistentKeepalive = 25',
        '',
      ].join('\n'),
    );
  });

  it('never routes IPv6 into a tunnel that has no IPv6 address', () => {
    // The assertion above pins the string; this one pins the REASON, so a
    // future "restore the full tunnel" cannot quietly put `::/0` back while
    // the interface is still IPv4-only. An explicit caller list is not
    // touched — a deployment that really does hand out IPv6 addresses passes
    // its own AllowedIPs, and that path stays verbatim.
    expect(buildWireguardClientConfig(base)).not.toContain('::/0');
    const explicit = buildWireguardClientConfig({ ...base, clientAllowedIps: ['::/0'] });
    expect(explicit).toContain('AllowedIPs = ::/0');
  });

  it('carries no AmneziaWG directive whatsoever', () => {
    const out = buildWireguardClientConfig(base);
    for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      expect(out).not.toContain(key);
    }
  });

  it('defaults to a full IPv4 tunnel and takes an explicit split list', () => {
    // IPv4 only, and that is the whole default rather than half of one. The
    // interface this config describes gets exactly ONE address line, from
    // `allowedIp`, and every address this panel allocates is IPv4 (10.66.66.0/24
    // and 10.68.0.0/16 on this fleet). So `::/0` used to tell the client to
    // route all of its IPv6 into a tunnel with no IPv6 address at all — a black
    // hole for every dual-stacked destination, which on a phone is most of
    // them. Dropped in 572a3189; these assertions were pinned to the old string
    // and are the only thing that broke.
    expect(buildWireguardClientConfig(base)).toContain('AllowedIPs = 0.0.0.0/0');
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
