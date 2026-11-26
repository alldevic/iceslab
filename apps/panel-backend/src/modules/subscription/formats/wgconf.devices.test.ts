import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildWgQuickConf } from './wgconf.js';
import { buildAwgVpnLink } from './amneziavpn.js';
import { disambiguateEndpointLabels } from '../subscription.service.js';
import { ofDevice } from '../endpoint-identity.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

// 9.4: a user holds several devices on every WireGuard-family node, one
// endpoint each; a single-tunnel file is one device's.

const awgEp = {
  protocol: 'amneziawg',
  nodeName: 'eu-1',
  host: 'n1.example.com',
  port: 51820,
  privateKey: 'cliPriv64',
  allowedIp: '10.0.0.42/32',
  serverPublicKey: 'srvPub64',
  jc: 4, jmin: 40, jmax: 70, s1: 72, s2: 56, s3: 32, s4: 16, h1: 100, h2: 200, h3: 300, h4: 400,
  i1: '', i2: '', i3: '', i4: '', i5: '',
  uri: '',
} as unknown as SubscriptionEndpoint;

const wgEp = {
  protocol: 'wireguard',
  nodeName: 'eu-2',
  host: 'n2.example.com',
  port: 51821,
  privateKey: 'wgPriv64',
  allowedIp: '10.77.77.42/32',
  serverPublicKey: 'wgSrvPub64',
  uri: '',
} as unknown as SubscriptionEndpoint;

const dev = (base: SubscriptionEndpoint, n: number): SubscriptionEndpoint =>
  ({
    ...base,
    privateKey: `${(base as { privateKey: string }).privateKey}-${n}`,
    allowedIp: `10.0.0.${n + 1}/32`,
    deviceId: `id-${n}`,
    deviceIndex: n,
  }) as SubscriptionEndpoint;

describe('devices: one tunnel of one device', () => {
  const awg = [dev(awgEp, 1), dev(awgEp, 2), dev(awgEp, 3)];

  it('is device 1 without ?device=, byte for byte what an endpoint without a device gives', () => {
    expect(buildWgQuickConf(awg)).toContain('PrivateKey = cliPriv64-1');
    expect(buildWgQuickConf([{ ...awgEp, privateKey: 'cliPriv64-1', allowedIp: '10.0.0.2/32' } as SubscriptionEndpoint])).toBe(
      buildWgQuickConf(awg),
    );
    expect(buildWgQuickConf(awg, undefined, '1')).toBe(buildWgQuickConf(awg));
  });

  it('is the asked one by number or by id, with its own key and address', () => {
    expect(buildWgQuickConf(awg, undefined, '2')).toContain('PrivateKey = cliPriv64-2');
    expect(buildWgQuickConf(awg, undefined, '3')).toContain('Address = 10.0.0.4/32');
    expect(buildWgQuickConf(awg, 'eu-1', 'id-2')).toContain('PrivateKey = cliPriv64-2');
    expect(buildWgQuickConf(awg, undefined, '4')).toBe('');
    expect(buildWgQuickConf(awg, undefined, 'nope')).toBe('');
  });

  it('applies to plain WireGuard too', () => {
    const wg = [dev(wgEp, 1), dev(wgEp, 2)];
    expect(buildWgQuickConf(wg, undefined, '2')).toContain('PrivateKey = wgPriv64-2');
    expect(buildWgQuickConf(wg, undefined, '2')).not.toMatch(/^Jc = /m);
  });

  it('the AmneziaVPN key is the device’s, and names device 2 on', () => {
    const decode = (link: string) => {
      const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
      // qCompress: 4-byte length, then zlib.
      return JSON.stringify(JSON.parse(inflateSync(raw.subarray(4)).toString('utf8')));
    };
    const one = decode(buildAwgVpnLink(awg));
    const two = decode(buildAwgVpnLink(awg, undefined, '2'));
    expect(one).toContain('cliPriv64-1');
    expect(two).toContain('cliPriv64-2');
    expect(two).toContain('#2');
    expect(one).not.toContain('#');
    expect(buildAwgVpnLink(awg, undefined, '9')).toBe('');
  });

  it('ofDevice: a number among the live ones or an id; an endpoint without a device is device 1', () => {
    const eps = [{ deviceIndex: 1, deviceId: 'a' }, { deviceIndex: 2, deviceId: 'b' }, {}];
    expect(ofDevice(eps)).toEqual([eps[0], eps[2]]);
    expect(ofDevice(eps, '2')).toEqual([eps[1]]);
    expect(ofDevice(eps, 'b')).toEqual([eps[1]]);
    expect(ofDevice(eps, '7')).toEqual([]);
  });
});

describe('devices: the label rule sees one server, not a collision', () => {
  it('leaves device 1’s label as it was and gives the later devices the same label', () => {
    const awg = [dev(awgEp, 1), dev(awgEp, 2), dev(awgEp, 3)];
    const lone = [{ ...awg[0]! }];
    disambiguateEndpointLabels(lone);
    disambiguateEndpointLabels(awg);
    expect(awg.map((e) => e.nodeName)).toEqual([lone[0]!.nodeName, lone[0]!.nodeName, lone[0]!.nodeName]);
    expect(awg[0]!.nodeName).toBe('eu-1');
  });

  it('still tells two real collisions apart', () => {
    const a = { ...dev(awgEp, 1), key: 'host-a', port: 1 } as SubscriptionEndpoint;
    const b = { ...dev(awgEp, 1), key: 'host-b', port: 2 } as SubscriptionEndpoint;
    const b2 = { ...dev(awgEp, 2), key: 'host-b', port: 2 } as SubscriptionEndpoint;
    disambiguateEndpointLabels([a, b, b2]);
    expect(a.nodeName).not.toBe(b.nodeName);
    expect(b2.nodeName).toBe(b.nodeName);
  });
});

describe('devices: the preshared key of the endpoint (9.5)', () => {
  const decode = (link: string) => {
    const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
    const envelope = JSON.parse(inflateSync(raw.subarray(4)).toString('utf8'));
    return JSON.parse(envelope.containers[0].awg.last_config) as Record<string, unknown>;
  };
  const keyed = (base: SubscriptionEndpoint, n: number) => ({ ...dev(base, n), presharedKey: `psk-${n}` }) as SubscriptionEndpoint;

  it('is the picked device’s own, in the conf of AmneziaWG and of plain WireGuard and in psk_key of the AmneziaVPN key', () => {
    const awg = [keyed(awgEp, 1), keyed(awgEp, 2)];
    const wg = [keyed(wgEp, 1), keyed(wgEp, 2)];
    expect(buildWgQuickConf(awg, undefined, '2')).toContain('PublicKey = srvPub64\nPresharedKey = psk-2\n');
    expect(buildWgQuickConf(wg, undefined, '1')).toContain('PublicKey = wgSrvPub64\nPresharedKey = psk-1\n');
    expect(decode(buildAwgVpnLink(awg, undefined, '2')).psk_key).toBe('psk-2');
    expect(decode(buildAwgVpnLink(awg)).psk_key).toBe('psk-1');
  });

  it('an endpoint without one (flag off) gives the output it gave before: no line, no psk_key', () => {
    const awg = [dev(awgEp, 1)];
    expect(buildWgQuickConf(awg)).not.toContain('PresharedKey');
    expect(buildWgQuickConf([dev(wgEp, 1)])).not.toContain('PresharedKey');
    expect('psk_key' in decode(buildAwgVpnLink(awg))).toBe(false);
  });
});
