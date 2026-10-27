import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildWgQuickConf } from './wgconf.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

const awgEp: SubscriptionEndpoint = {
  protocol: 'amneziawg',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51820,
  privateKey: 'cliPriv64',
  allowedIp: '10.0.0.42/32',
  serverPublicKey: 'srvPub64',
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
  uri: '',
};

const hysteriaEp: SubscriptionEndpoint = {
  protocol: 'hysteria',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 443,
  password: 'hy-secret',
  uri: 'hysteria2://...',
};

describe('buildWgQuickConf', () => {
  it('emits an [Interface]+[Peer] config for an AmneziaWG endpoint', () => {
    const out = buildWgQuickConf([awgEp]);
    expect(out).toContain('[Interface]');
    expect(out).toContain('[Peer]');
    expect(out).toContain('PrivateKey = cliPriv64');
    expect(out).toContain('Address = 10.0.0.42/32');
    expect(out).toContain('PublicKey = srvPub64');
    expect(out).toContain('Endpoint = n1.example.com:51820');
  });

  it('includes the obfuscation parameters from the inbound', () => {
    const out = buildWgQuickConf([awgEp]);
    for (const want of ['Jc = 4', 'S1 = 72', 'S4 = 16', 'H1 = 100', 'H4 = 400']) {
      expect(out).toContain(want);
    }
  });

  it('returns empty string when no AmneziaWG endpoint is present', () => {
    expect(buildWgQuickConf([])).toBe('');
    expect(buildWgQuickConf([hysteriaEp])).toBe('');
  });

  it('skips non-AmneziaWG endpoints, only the first awg endpoint is used', () => {
    const out = buildWgQuickConf([hysteriaEp, awgEp]);
    expect(out).toContain('Address = 10.0.0.42/32');
    expect(out).not.toContain('hy-secret');
  });

  it('emits the first AmneziaWG endpoint when multiple exist and no node is named', () => {
    const second: SubscriptionEndpoint = {
      ...awgEp,
      nodeName: 'us-1',
      host: 'n2.example.com',
      allowedIp: '10.0.0.43/32',
    };
    const out = buildWgQuickConf([awgEp, second]);
    expect(out).toContain('Endpoint = n1.example.com:51820');
    expect(out).not.toContain('n2.example.com');
  });

  // Regression: a user with two AmneziaWG nodes got the FIRST node's config from
  // every per-node link because they all hit bare ?format=wgconf. The per-node
  // link now pins ?node=<nodeName>, which must select that node's tunnel.
  it('selects the AmneziaWG endpoint matching nodeName', () => {
    const second: SubscriptionEndpoint = {
      ...awgEp,
      nodeName: 'us-1',
      host: 'n2.example.com',
      allowedIp: '10.0.0.43/32',
    };
    const out = buildWgQuickConf([awgEp, second], 'us-1');
    expect(out).toContain('Endpoint = n2.example.com:51820');
    expect(out).toContain('Address = 10.0.0.43/32');
    expect(out).not.toContain('n1.example.com');
  });

  it('returns empty when the named node has no AmneziaWG endpoint', () => {
    expect(buildWgQuickConf([awgEp], 'no-such-node')).toBe('');
  });

  it('output is byte-deterministic for the same input', () => {
    expect(buildWgQuickConf([awgEp])).toBe(buildWgQuickConf([awgEp]));
  });
});

describe('devices: a user holds several keys on one node', () => {
  const dev = (n: number, extra: Partial<SubscriptionEndpoint> = {}) =>
    ({
      ...awgEp,
      privateKey: `priv-${n}`,
      allowedIp: `10.0.0.${n + 1}/32`,
      deviceId: `id-${n}`,
      deviceIndex: n,
      ...extra,
    }) as SubscriptionEndpoint;
  const two = [dev(1), dev(2, { presharedKey: 'psk-2' })];

  it('device 1 without ?device=, the asked one with it, by number or id', () => {
    expect(buildWgQuickConf(two)).toContain('PrivateKey = priv-1');
    expect(buildWgQuickConf(two, undefined, '2')).toContain('PrivateKey = priv-2');
    expect(buildWgQuickConf(two, 'eu-1', 'id-2')).toContain('Address = 10.0.0.3/32');
    expect(buildWgQuickConf(two, undefined, '3')).toBe('');
  });

  it("carries the device's preshared key in its peer, and nothing when it has none", () => {
    expect(buildWgQuickConf(two, undefined, '2')).toContain('PublicKey = srvPub64\nPresharedKey = psk-2\nAllowedIPs');
    expect(buildWgQuickConf(two)).not.toContain('PresharedKey');
  });

  it('the AmneziaVPN key carries it too, and names device 2 on', async () => {
    const { buildAwgVpnLink } = await import('./amneziavpn.js');
    const decode = (link: string) => {
      const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
      // qCompress: 4-byte length, then zlib.
      return JSON.parse(inflateSync(raw.subarray(4)).toString('utf8'));
    };
    const one = JSON.stringify(decode(buildAwgVpnLink(two)));
    const second = JSON.stringify(decode(buildAwgVpnLink(two, undefined, '2')));
    expect(one).not.toContain('psk-2');
    expect(second).toContain('psk-2');
    expect(second).toContain('#2');
  });
});
