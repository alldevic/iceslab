import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildWgQuickConf, wgConfName, wgClientAllowedIps, WG_NAME_MAX } from './wgconf.js';
import { buildAwgVpnLink } from './amneziavpn.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

// 9.8: the DNS line, the tunnel name and `::/0` in every builder of a wg config.

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

const decodeKey = (link: string) => {
  const raw = Buffer.from(link.replace(/^vpn:\/\//, ''), 'base64url');
  const envelope = JSON.parse(inflateSync(raw.subarray(4)).toString('utf8')) as Record<string, unknown> & {
    containers: { awg: { last_config: string } }[];
  };
  return { envelope, config: JSON.parse(envelope.containers[0]!.awg.last_config) as Record<string, unknown> };
};

describe('DNS from the panel setting', () => {
  it('writes a DNS line into both flavours', () => {
    const opts = { dns: ['1.1.1.1', '2606:4700:4700::1111'] };
    for (const ep of [awgEp, wgEp]) {
      const out = buildWgQuickConf([ep], undefined, undefined, opts);
      expect(out).toContain('\nDNS = 1.1.1.1, 2606:4700:4700::1111\n');
      // In [Interface], before [Peer].
      expect(out.indexOf('DNS =')).toBeLessThan(out.indexOf('[Peer]'));
    }
  });

  it('no setting, or an empty list: no DNS line, the output of the base', () => {
    for (const ep of [awgEp, wgEp]) {
      const base = buildWgQuickConf([ep]);
      expect(base).not.toContain('DNS');
      expect(buildWgQuickConf([ep], undefined, undefined, { dns: [] })).toBe(base);
      expect(buildWgQuickConf([ep], undefined, undefined, { dns: [], dropIpv6: false })).toBe(base);
    }
    const key = buildAwgVpnLink([awgEp]);
    expect(buildAwgVpnLink([awgEp], undefined, undefined, { dns: [] })).toBe(key);
    expect(decodeKey(key).envelope).not.toHaveProperty('dns1');
  });

  it('the AmneziaVPN key takes the first two as dns1 and dns2', () => {
    const { envelope } = decodeKey(buildAwgVpnLink([awgEp], undefined, undefined, { dns: ['1.1.1.1', '9.9.9.9', '8.8.8.8'] }));
    expect(envelope.dns1).toBe('1.1.1.1');
    expect(envelope.dns2).toBe('9.9.9.9');
    expect(envelope).not.toHaveProperty('dns3');
    const one = decodeKey(buildAwgVpnLink([awgEp], undefined, undefined, { dns: ['1.1.1.1'] })).envelope;
    expect(one.dns1).toBe('1.1.1.1');
    expect(one).not.toHaveProperty('dns2');
  });
});

describe('::/0 in AllowedIPs', () => {
  it('is there by default and with the switch off, byte for byte', () => {
    for (const ep of [awgEp, wgEp]) {
      const base = buildWgQuickConf([ep]);
      expect(base).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
      expect(buildWgQuickConf([ep], undefined, undefined, { dropIpv6: false })).toBe(base);
    }
    expect(JSON.stringify(decodeKey(buildAwgVpnLink([awgEp])).config)).toContain('::/0');
  });

  it('is gone from every builder with the switch on, and only it', () => {
    for (const ep of [awgEp, wgEp]) {
      const on = buildWgQuickConf([ep], undefined, undefined, { dropIpv6: true });
      expect(on).toContain('AllowedIPs = 0.0.0.0/0\n');
      expect(on).not.toContain('::/0');
      expect(on).toBe(buildWgQuickConf([ep]).replace('AllowedIPs = 0.0.0.0/0, ::/0', 'AllowedIPs = 0.0.0.0/0'));
    }
    const cfg = JSON.stringify(decodeKey(buildAwgVpnLink([awgEp], undefined, undefined, { dropIpv6: true })).config);
    expect(cfg).toContain('0.0.0.0/0');
    expect(cfg).not.toContain('::/0');
  });

  it('holds for any device', () => {
    const dev = (n: number) => ({ ...awgEp, deviceId: `d${n}`, deviceIndex: n }) as SubscriptionEndpoint;
    for (const n of ['1', '2', '3']) {
      const out = buildWgQuickConf([dev(1), dev(2), dev(3)], undefined, n, { dropIpv6: true });
      expect(out).not.toContain('::/0');
    }
  });

  it('is decided in one function', () => {
    expect(wgClientAllowedIps(undefined)).toBeUndefined();
    expect(wgClientAllowedIps({ dropIpv6: false })).toBeUndefined();
    expect(wgClientAllowedIps({ dropIpv6: true })).toEqual(['0.0.0.0/0']);
  });
});

describe('the tunnel name', () => {
  it('is the first line of the config and the same string the file gets', () => {
    expect(buildWgQuickConf([awgEp], undefined, undefined, { brand: 'Onegin' }).split('\n')[0]).toBe(
      `# Name = ${wgConfName('Onegin', 'eu-1', 'amneziawg')}`,
    );
    expect(buildWgQuickConf([wgEp], undefined, undefined, { brand: 'Onegin' }).split('\n')[0]).toBe('# Name = Onegi-eu-2-wg');
    // No brand given, no comment: what the base wrote.
    expect(buildWgQuickConf([awgEp]).split('\n')[0]).toBe('[Interface]');
  });

  it('never exceeds 15 characters, whatever the brand and the node', () => {
    for (const brand of ['Iceslab', 'OneginVPNPro', 'A'.repeat(64), 'Очень длинное имя бренда']) {
      for (const node of ['eu-1', 'amsterdam-primary-node-01', '🇳🇱 nl-01 · Shadowsocks', 'x'.repeat(80)]) {
        for (const device of [1, 2, 10]) {
          for (const proto of ['amneziawg', 'wireguard'] as const) {
            const name = wgConfName(brand, node, proto, device);
            expect(name.length, `${brand}/${node}/${proto}/${device}: ${name}`).toBeLessThanOrEqual(WG_NAME_MAX);
            expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
          }
        }
      }
    }
  });

  it('turns a run of unusable characters into one separator and falls back when nothing is left', () => {
    expect(wgConfName('Brand', '🇳🇱 s2', 'wireguard')).toBe('Brand-s2-wg');
    expect(wgConfName('Бренд', undefined, undefined)).toBe('subscription');
    expect(wgConfName('', 'eu-1', 'wireguard')).toBe('subsc-eu-1-wg');
    expect(wgConfName('a b/c\\d', undefined, 'wireguard')).toBe('a_b_c_d-wg');
  });

  it('cuts the brand at a word, and keeps the node, kind and device', () => {
    // Room for 9: no word boundary at 9, so the word before it.
    expect(wgConfName('OneginVPNPro', undefined, 'amneziawg', 2)).toBe('Onegin-awg-2');
    // A single long word has no boundary: hard cut.
    expect(wgConfName('Abcdefghijklmnop', 'eu-1', 'amneziawg', 2)).toBe('Abcd-eu-1-awg-2');
    expect(wgConfName('OneginVPNPro', 'eu-1', 'amneziawg', 2).endsWith('-eu-1-awg-2')).toBe(true);
  });

  it('one buyer\'s devices spell the brand and the node the same, and differ by the number', () => {
    for (const node of ['eu-1', 'amsterdam-primary-1']) {
      const names = [1, 2, 3, 9].map((d) => wgConfName('Iceslab', node, 'amneziawg', d));
      expect(names[1]!.replace(/-2$/, '')).toBe(names[0]);
      expect(names[2]!.replace(/-3$/, '')).toBe(names[0]);
      expect(names[3]!.replace(/-9$/, '')).toBe(names[0]);
    }
  });

  it('two nodes with a long common beginning get different names', () => {
    const a = wgConfName('Iceslab', 'amsterdam-primary-1', 'amneziawg');
    const b = wgConfName('Iceslab', 'amsterdam-primary-2', 'amneziawg');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(WG_NAME_MAX);
    expect(b.length).toBeLessThanOrEqual(WG_NAME_MAX);
    // Stable: the same node is the same name every time.
    expect(wgConfName('Iceslab', 'amsterdam-primary-1', 'amneziawg')).toBe(a);
  });

  it('tells devices and kinds apart; device 1 is unmarked', () => {
    const names = [
      wgConfName('Iceslab', 'eu-1', 'amneziawg', 1),
      wgConfName('Iceslab', 'eu-1', 'amneziawg', 2),
      wgConfName('Iceslab', 'eu-1', 'amneziawg', 3),
      wgConfName('Iceslab', 'eu-1', 'wireguard', 1),
      wgConfName('Iceslab', 'eu-1', 'wireguard', 2),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(wgConfName('Iceslab', 'eu-1', 'amneziawg', 1)).toBe(wgConfName('Iceslab', 'eu-1', 'amneziawg'));
    expect(names[0]).not.toMatch(/-1$/);
  });
});
