import { describe, expect, it } from 'vitest';
import {
  generateSubnet6,
  intToIp,
  ipToInt,
  ipv4OfIpv6,
  ipv6OfIpv4,
  ipv6OfIpv4InPrefix,
  isSubnet6,
  normalizeSubnet6,
  parseSubnet,
  serverIpv6,
} from './amneziawg.subnet.js';

describe('ipToInt / intToIp', () => {
  it('round-trips boundary values', () => {
    for (const ip of ['0.0.0.0', '10.0.0.1', '172.16.5.10', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip);
    }
  });

  it('rejects malformed addresses', () => {
    expect(() => ipToInt('10.0.0')).toThrow();
    expect(() => ipToInt('10.0.0.256')).toThrow();
    expect(() => ipToInt('10.0.0.x')).toThrow();
    expect(() => ipToInt('10..0.1')).toThrow();
  });
});

describe('parseSubnet', () => {
  it('produces the right usable range for 10.0.0.0/24', () => {
    const r = parseSubnet('10.0.0.0/24');
    expect(intToIp(r.base)).toBe('10.0.0.0');
    expect(intToIp(r.serverIp)).toBe('10.0.0.1');
    expect(intToIp(r.firstUsable)).toBe('10.0.0.2');
    expect(intToIp(r.lastUsable)).toBe('10.0.0.254');
    expect(r.lastUsable - r.firstUsable + 1).toBe(253);
  });

  it('aligns ip to network boundary', () => {
    const r = parseSubnet('10.0.0.55/24');
    expect(intToIp(r.base)).toBe('10.0.0.0');
  });

  it('handles /23', () => {
    const r = parseSubnet('10.0.0.0/23');
    expect(intToIp(r.firstUsable)).toBe('10.0.0.2');
    expect(intToIp(r.lastUsable)).toBe('10.0.1.254');
  });

  it('rejects too-small or invalid prefixes', () => {
    expect(() => parseSubnet('10.0.0.0/31')).toThrow();
    expect(() => parseSubnet('10.0.0.0/7')).toThrow();
    expect(() => parseSubnet('10.0.0.0')).toThrow();
    expect(() => parseSubnet('not-a-cidr')).toThrow();
  });
});

describe('subnet6: a ULA /64', () => {
  it('takes fc00::/7 prefixes of four groups and ::/64, and nothing else', () => {
    expect(isSubnet6('fd12:3456:789a:1::/64')).toBe(true);
    expect(isSubnet6('fc00:0:0:1::/64')).toBe(true);
    expect(isSubnet6('FD12:3456:789A:1::/64')).toBe(true);
    for (const bad of [
      '2001:db8:1:2::/64', // global unicast
      'fe80:0:0:1::/64', // link-local
      'fd12:3456:789a:1::/48', // not a /64
      'fd12:3456:789a:1::/96',
      'fd12:3456:789a::/64', // three groups: two spellings of one prefix are not taken
      'fd12:3456:789a:1::1/64', // host bits set
      'fd12:3456:789a:1::',
      '10.0.0.0/24',
      '',
    ]) {
      expect(isSubnet6(bad), bad).toBe(false);
    }
  });

  it('compares prefixes by their canonical spelling', () => {
    expect(normalizeSubnet6('FD12:3456:789A:0001::/64')).toBe('fd12:3456:789a:1::/64');
    expect(normalizeSubnet6('fd12:3456:789a:1::/64')).toBe('fd12:3456:789a:1::/64');
    expect(normalizeSubnet6('2001:db8:1:2::/64')).toBeNull();
  });

  it('generates a valid ULA /64 from random bytes, a different one each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const g = generateSubnet6();
      expect(isSubnet6(g), g).toBe(true);
      expect(g.startsWith('fd')).toBe(true);
      seen.add(g);
    }
    expect(seen.size).toBeGreaterThan(45);
    expect(generateSubnet6(() => Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0x00, 0x01]))).toBe('fd12:3456:789a:1::/64');
  });
});

describe('ipv6OfIpv4: the client IPv6 from the IPv4 address', () => {
  const S6 = 'fd12:3456:789a:1::/64';

  it('puts the four octets in the low 32 bits of the /64', () => {
    expect(ipv6OfIpv4(S6, '10.66.66.7')).toBe('fd12:3456:789a:1:0:0:a42:4207');
    expect(ipv6OfIpv4(S6, '10.0.0.2')).toBe('fd12:3456:789a:1:0:0:a00:2');
    expect(ipv6OfIpv4(S6, '255.255.255.255')).toBe('fd12:3456:789a:1:0:0:ffff:ffff');
  });

  it('is one-to-one: every address of a /16 maps to its own IPv6 and back', () => {
    const seen = new Set<string>();
    for (let a = 0; a < 256; a++) {
      for (const b of [0, 1, 2, 77, 255]) {
        const v4 = `10.66.${a}.${b}`;
        const v6 = ipv6OfIpv4(S6, v4);
        expect(ipv4OfIpv6(S6, v6)).toBe(v4);
        seen.add(v6);
      }
    }
    expect(seen.size).toBe(256 * 5);
  });

  it('stays inside the subnet6 and does not read a foreign prefix back', () => {
    expect(ipv6OfIpv4(S6, '10.66.66.7').startsWith('fd12:3456:789a:1:')).toBe(true);
    expect(ipv4OfIpv6(S6, ipv6OfIpv4('fd99:0:0:1::/64', '10.66.66.7'))).toBeNull();
    expect(ipv4OfIpv6(S6, 'fd12:3456:789a:1:0:1:a42:4207')).toBeNull();
  });

  it('holds for an IPv4 subnet wider than /24, the whole 32 bits go in', () => {
    const r = parseSubnet('10.8.0.0/16');
    const first = ipv6OfIpv4(S6, intToIp(r.firstUsable));
    const last = ipv6OfIpv4(S6, intToIp(r.lastUsable));
    expect(first).toBe('fd12:3456:789a:1:0:0:a08:2');
    expect(last).toBe('fd12:3456:789a:1:0:0:a08:fffe');
    expect(ipv4OfIpv6(S6, last)).toBe('10.8.255.254');
    // 10.8.1.2 and 10.8.2.1 differ in the third octet only and must not meet.
    expect(ipv6OfIpv4(S6, '10.8.1.2')).not.toBe(ipv6OfIpv4(S6, '10.8.2.1'));
  });

  it('derives the server address from the .1 of the IPv4 subnet', () => {
    expect(serverIpv6(S6, '10.66.66.0/24')).toBe('fd12:3456:789a:1:0:0:a42:4201');
  });

  it('refuses a prefix that is not a ULA /64 and an address that is not IPv4', () => {
    expect(() => ipv6OfIpv4('2001:db8:1:2::/64', '10.0.0.2')).toThrow();
    expect(() => ipv6OfIpv4(S6, '10.0.0')).toThrow();
  });
});

describe('ipv6OfIpv4InPrefix: the same derivation in a real /64 (18.11)', () => {
  it('puts the IPv4 in the low 32 bits of the node\'s /64, one-to-one with the ULA rule', () => {
    expect(ipv6OfIpv4InPrefix('2001:db8:77:1::/64', '10.66.66.7')).toBe('2001:db8:77:1:0:0:a42:4207');
    // The same address the ULA path gives for the same low bits.
    expect(ipv6OfIpv4InPrefix('fd12:3456:789a:1::/64', '10.66.66.7')).toBe(ipv6OfIpv4('fd12:3456:789a:1::/64', '10.66.66.7'));
    expect(ipv6OfIpv4InPrefix('2001:db8:77:1::/64', '10.66.66.7')).not.toBe(ipv6OfIpv4InPrefix('2001:db8:77:1::/64', '10.66.66.8'));
    expect(ipv6OfIpv4InPrefix('2001:db8:77:1::/64', '10.66.66.7').startsWith('2001:db8:77:1:')).toBe(true);
  });

  it('refuses what is not a four-group /64', () => {
    expect(() => ipv6OfIpv4InPrefix('2001:db8:77::/48', '10.0.0.2')).toThrow();
    expect(() => ipv6OfIpv4InPrefix('2001:db8:77::/64', '10.0.0.2')).toThrow();
  });
});
