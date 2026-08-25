import { describe, expect, it } from 'vitest';
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

const wgEp: SubscriptionEndpoint = {
  protocol: 'wireguard',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51821,
  privateKey: 'cliPriv64',
  allowedIp: '10.77.77.42/32',
  serverPublicKey: 'wgSrvPub64',
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

  it('emits a plain config for a wireguard endpoint', () => {
    const out = buildWgQuickConf([wgEp]);
    expect(out).toContain('[Interface]');
    expect(out).toContain('PrivateKey = cliPriv64');
    expect(out).toContain('Address = 10.77.77.42/32');
    expect(out).toContain('PublicKey = wgSrvPub64');
    expect(out).toContain('Endpoint = n1.example.com:51821');
  });

  // The reason plain WireGuard is a separate protocol at all: stock clients
  // abort on the first key they don't know, so a single leaked Jc/S/H line
  // makes the file unusable for exactly the apps this format targets.
  it('emits no AmneziaWG directive for a wireguard endpoint', () => {
    const out = buildWgQuickConf([wgEp]);
    for (const key of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1']) {
      expect(out).not.toContain(`${key} = `);
    }
  });

  it('serves a wireguard-only subscription without a node hint', () => {
    expect(buildWgQuickConf([hysteriaEp, wgEp])).toContain('Address = 10.77.77.42/32');
  });

  // One node can carry both tunnels (separate interfaces, subnets and ports),
  // so ?node= alone is ambiguous and the flavour has to be pinnable.
  it('picks the flavour when a node serves both', () => {
    const both = [awgEp, wgEp];
    expect(buildWgQuickConf(both, 'eu-1', 'wireguard')).toContain('Address = 10.77.77.42/32');
    expect(buildWgQuickConf(both, 'eu-1', 'amneziawg')).toContain('Address = 10.0.0.42/32');
    expect(buildWgQuickConf(both, 'eu-1', 'amneziawg')).toContain('Jc = 4');
  });

  it('returns empty when the requested flavour is absent', () => {
    expect(buildWgQuickConf([awgEp], undefined, 'wireguard')).toBe('');
    expect(buildWgQuickConf([wgEp], undefined, 'amneziawg')).toBe('');
  });
});
