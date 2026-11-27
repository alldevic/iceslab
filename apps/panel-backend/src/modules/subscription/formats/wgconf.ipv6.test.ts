import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildWgQuickConf, tunnelHasIpv6, wgClientAllowedIps } from './wgconf.js';
import { buildAwgVpnLink } from './amneziavpn.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

// 18.9: the second address in the clients' configs, and what AllowedIPs does with it.

const V6 = 'fd12:3456:789a:1:0:0:a00:2a/128';

const awgEp = (extra: object = {}) =>
  ({
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
    ...extra,
  }) as unknown as SubscriptionEndpoint;

const wgEp = (extra: object = {}) =>
  ({
    protocol: 'wireguard',
    nodeName: 'eu-2',
    host: 'n2.example.com',
    port: 51821,
    privateKey: 'wgPriv64',
    allowedIp: '10.77.77.42/32',
    serverPublicKey: 'wgSrvPub64',
    uri: '',
    ...extra,
  }) as unknown as SubscriptionEndpoint;

const decodeKey = (link: string) => {
  const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
  const envelope = JSON.parse(inflateSync(raw.subarray(4)).toString('utf8')) as {
    containers: { awg: { last_config: string } }[];
  };
  return JSON.parse(envelope.containers[0]!.awg.last_config) as Record<string, unknown>;
};

describe('an endpoint with allowedIp6', () => {
  it('has both addresses in the .conf of both flavours, and ::/0 in AllowedIPs', () => {
    for (const ep of [awgEp({ allowedIp6: V6 }), wgEp({ allowedIp6: V6 })]) {
      const out = buildWgQuickConf([ep]);
      expect(out).toMatch(/^Address = 10\.\d+\.\d+\.42\/32, fd12:3456:789a:1:0:0:a00:2a\/128$/m);
      expect(out).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
    }
  });

  it('keeps ::/0 under the switch that drops it: the tunnel has an IPv6 of its own', () => {
    for (const ep of [awgEp({ allowedIp6: V6 }), wgEp({ allowedIp6: V6 })]) {
      expect(buildWgQuickConf([ep], undefined, undefined, { dropIpv6: true })).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
    }
    // And the same tunnel without the address is as before: the switch acts.
    expect(buildWgQuickConf([awgEp()], undefined, undefined, { dropIpv6: true })).toContain('AllowedIPs = 0.0.0.0/0\n');
  });

  it('is told apart from a tunnel without one by the function 18.7 left for it', () => {
    expect(tunnelHasIpv6({ allowedIp: '10.0.0.42/32', allowedIp6: V6 })).toBe(true);
    expect(tunnelHasIpv6({ allowedIp: '10.0.0.42/32' })).toBe(false);
    expect(wgClientAllowedIps({ dropIpv6: true }, { allowedIp: '10.0.0.42/32', allowedIp6: V6 })).toBeUndefined();
  });

  it('is byte for byte the old .conf without allowedIp6', () => {
    for (const make of [awgEp, wgEp]) {
      expect(buildWgQuickConf([make()])).toBe(buildWgQuickConf([make({ allowedIp6: undefined })]));
      expect(buildWgQuickConf([make()])).not.toContain('fd12');
    }
  });

  it('leaves client_ip of the vpn:// key IPv4 only, the default of the milestone (Q3), and the key as it was', () => {
    const plain = decodeKey(buildAwgVpnLink([awgEp()]));
    const dual = decodeKey(buildAwgVpnLink([awgEp({ allowedIp6: V6 })]));
    expect(dual.client_ip).toBe('10.0.0.42/32');
    expect(dual).toEqual(plain);
    // The key carries no IPv6 address, so the switch acts on it as on any IPv4 tunnel.
    const dropped = decodeKey(buildAwgVpnLink([awgEp({ allowedIp6: V6 })], undefined, undefined, { dropIpv6: true }));
    expect(JSON.stringify(dropped)).not.toContain('::/0');
  });
});
