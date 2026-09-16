import { describe, expect, it } from 'vitest';
import { buildAmneziawgClientConfig, type AmneziawgClientConfigOpts } from './wgconf.js';

const baseOpts: AmneziawgClientConfigOpts = {
  privateKey: 'cliPriv64',
  allowedIp: '10.0.0.42/32',
  serverPublicKey: 'srvPub64',
  host: 'n1.example.com',
  port: 51820,
  jc: 4,
  jmin: 40,
  jmax: 70,
  s1: 72,
  s2: 56,
  s3: 32,
  s4: 16,
  h1: 100,
  h2: 200,
  h3: 300,
  h4: 400,
};

describe('buildAmneziawgClientConfig', () => {
  it('emits an [Interface] block with all obfuscation fields', () => {
    const out = buildAmneziawgClientConfig(baseOpts);
    expect(out).toContain('[Interface]');
    expect(out).toContain('PrivateKey = cliPriv64');
    expect(out).toContain('Address = 10.0.0.42/32');
    for (const want of [
      'Jc = 4',
      'Jmin = 40',
      'Jmax = 70',
      'S1 = 72',
      'S4 = 16',
      'H1 = 100',
      'H4 = 400',
    ]) {
      expect(out).toContain(want);
    }
  });

  it('emits a [Peer] block with server endpoint', () => {
    const out = buildAmneziawgClientConfig(baseOpts);
    expect(out).toContain('[Peer]');
    expect(out).toContain('PublicKey = srvPub64');
    expect(out).toContain('Endpoint = n1.example.com:51820');
  });

  it('defaults to a full IPv4 tunnel, and never claims IPv6 it cannot carry', () => {
    // Same reasoning as the plain WireGuard builder, and the same fix, applied
    // here on 2026-09-16 because it had only been half done: the [Interface]
    // gets exactly ONE address, from `allowedIp`, and every address this panel
    // allocates is IPv4 (10.66.66.0/24 and 10.68.0.0/16 on this fleet).
    // `::/0` told the client to route all of its IPv6 into a tunnel with no
    // IPv6 address at all — a black hole for every dual-stacked destination.
    const out = buildAmneziawgClientConfig(baseOpts);
    expect(out).toContain('AllowedIPs = 0.0.0.0/0');
    expect(out).not.toContain('::/0');
  });

  it('honours custom clientAllowedIps for split tunnels', () => {
    const out = buildAmneziawgClientConfig({
      ...baseOpts,
      clientAllowedIps: ['10.20.0.0/16', '192.168.1.0/24'],
    });
    expect(out).toContain('AllowedIPs = 10.20.0.0/16, 192.168.1.0/24');
    expect(out).not.toContain('0.0.0.0/0');
  });

  it('omits DNS line when none provided', () => {
    expect(buildAmneziawgClientConfig(baseOpts)).not.toContain('DNS = ');
  });

  it('emits DNS line when provided', () => {
    const out = buildAmneziawgClientConfig({ ...baseOpts, dns: ['1.1.1.1', '8.8.8.8'] });
    expect(out).toContain('DNS = 1.1.1.1, 8.8.8.8');
  });

  it('defaults PersistentKeepalive to 25', () => {
    expect(buildAmneziawgClientConfig(baseOpts)).toContain('PersistentKeepalive = 25');
  });

  it('honours explicit persistentKeepalive override', () => {
    const out = buildAmneziawgClientConfig({ ...baseOpts, persistentKeepalive: 60 });
    expect(out).toContain('PersistentKeepalive = 60');
  });

  it('produces output that ends with a newline (wg-quick is picky)', () => {
    const out = buildAmneziawgClientConfig(baseOpts);
    expect(out.endsWith('\n')).toBe(true);
  });
});
