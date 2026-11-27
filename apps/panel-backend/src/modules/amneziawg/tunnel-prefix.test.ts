import { describe, expect, it } from 'vitest';
import {
  bigIntToIpv6,
  interfaceSubnet64,
  ipv6NetworksOverlapText,
  ipv6ToBigInt,
  nodePrefixOverlaps,
  normalizeNodePrefix,
  parseNodePrefix,
} from './tunnel-prefix.js';

/** 18.11: the node's real prefix, as pure functions. */
describe('parseNodePrefix: a global prefix of /32 to /64', () => {
  it.each(['2001:db8:77::/48', '2001:db8:77:1::/64', '2a01:4f8::/32', '2001:db8:77:100::/56', '3fff::/32'])('takes %s', (p) => {
    expect(parseNodePrefix(p), p).not.toBeNull();
  });

  it.each([
    ['fd12:3456:789a:1::/64', 'ULA'],
    ['fc00::/48', 'ULA'],
    ['fe80::/64', 'link-local'],
    ['ff02::/32', 'multicast'],
    ['::1/64', 'loopback'],
    ['2001:db8:77:1::/65', 'longer than /64'],
    ['2001:db8:77:1::/128', 'a host'],
    ['2001:db8::/16', 'shorter than /32'],
    ['2001:db8:77:1::1/64', 'host bits set'],
    ['2001:db8:77::', 'no length'],
    ['10.0.0.0/24', 'IPv4'],
    ['2001:db8:77::%eth0/48', 'zone'],
    ['', 'empty'],
  ])('refuses %s (%s)', (p) => {
    expect(parseNodePrefix(p), p).toBeNull();
  });
});

describe('spelling', () => {
  it('writes the shortest form, lowercase, and reads it back', () => {
    for (const [text, canon] of [
      ['2001:0DB8:0077:0000:0000:0000:0000:0000/48', '2001:db8:77::/48'],
      ['2001:db8:77:1::/64', '2001:db8:77:1::/64'],
      ['2001:db8::/32', '2001:db8::/32'],
      ['2001:db8:0:0:1::/80', null],
    ] as const) {
      expect(normalizeNodePrefix(text), text).toBe(canon);
    }
    expect(bigIntToIpv6(ipv6ToBigInt('2001:db8:0:1:0:0:0:1')!)).toBe('2001:db8:0:1::1');
    expect(bigIntToIpv6(ipv6ToBigInt('2001:0:0:1:0:0:0:1')!)).toBe('2001:0:0:1::1');
    expect(bigIntToIpv6(ipv6ToBigInt('1:0:2:3:4:5:6:7')!)).toBe('1:0:2:3:4:5:6:7');
    expect(ipv6ToBigInt('1::2::3')).toBeNull();
    expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBeNull();
  });
});

describe('overlap', () => {
  it('one holds the other, or they are the same; neighbours do not overlap', () => {
    expect(nodePrefixOverlaps('2001:db8:77::/48', '2001:db8:77:5::/64')).toBe(true);
    expect(nodePrefixOverlaps('2001:db8:77:5::/64', '2001:db8:77::/48')).toBe(true);
    expect(nodePrefixOverlaps('2001:db8:77::/48', '2001:db8:77::/48')).toBe(true);
    expect(nodePrefixOverlaps('2001:db8:77::/48', '2001:db8:78::/48')).toBe(false);
    expect(nodePrefixOverlaps('2001:db8:77:1::/64', '2001:db8:77:2::/64')).toBe(false);
    expect(nodePrefixOverlaps('junk', '2001:db8:77::/48')).toBe(false);
  });

  it('a ULA /64 of a profile is compared by its range too', () => {
    expect(ipv6NetworksOverlapText('2001:db8:77::/48', 'fd12:3456:789a:1::/64')).toBe(false);
    expect(ipv6NetworksOverlapText('2001:db8:77::/48', '2001:db8:77:9::/64')).toBe(true);
  });
});

describe('interfaceSubnet64: one /64 per interface', () => {
  it('a /48 has 65536 of them, in order', () => {
    expect(interfaceSubnet64('2001:db8:77::/48', 0)).toBe('2001:db8:77:0::/64');
    expect(interfaceSubnet64('2001:db8:77::/48', 1)).toBe('2001:db8:77:1::/64');
    expect(interfaceSubnet64('2001:db8:77::/48', 2)).toBe('2001:db8:77:2::/64');
    expect(interfaceSubnet64('2001:db8:77::/48', 65535)).toBe('2001:db8:77:ffff::/64');
    expect(interfaceSubnet64('2001:db8:77::/48', 65536)).toBeNull();
  });

  it('a /56 has 256, a /63 two, a /64 one', () => {
    expect(interfaceSubnet64('2001:db8:77:100::/56', 255)).toBe('2001:db8:77:1ff::/64');
    expect(interfaceSubnet64('2001:db8:77:100::/56', 256)).toBeNull();
    expect(interfaceSubnet64('2001:db8:77:2::/63', 1)).toBe('2001:db8:77:3::/64');
    expect(interfaceSubnet64('2001:db8:77:2::/63', 2)).toBeNull();
    expect(interfaceSubnet64('2001:db8:77:1::/64', 0)).toBe('2001:db8:77:1::/64');
    expect(interfaceSubnet64('2001:db8:77:1::/64', 1)).toBeNull();
  });

  it('a /32 carries into the second group', () => {
    expect(interfaceSubnet64('2001:db8::/32', 0x10000)).toBe('2001:db8:1:0::/64');
  });

  it('refuses a bad prefix or index', () => {
    expect(interfaceSubnet64('fd12:3456:789a:1::/64', 0)).toBeNull();
    expect(interfaceSubnet64('2001:db8:77::/48', -1)).toBeNull();
  });
});
