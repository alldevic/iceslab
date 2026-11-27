import { describe, expect, it } from 'vitest';
import {
  canonicalIpv6,
  canonicalIpv6Host,
  canonicalNodeAddress,
  joinNodeAddress,
  parseNodeAddress,
} from '@iceslab/shared';

describe('parseNodeAddress', () => {
  it('reads host, host:port, v6, [v6] and [v6]:port', () => {
    expect(parseNodeAddress('node.example.com')).toEqual({ host: 'node.example.com', port: null, kind: 'name' });
    expect(parseNodeAddress('node.example.com:8443')).toEqual({ host: 'node.example.com', port: 8443, kind: 'name' });
    expect(parseNodeAddress('203.0.113.7:2000')).toEqual({ host: '203.0.113.7', port: 2000, kind: 'ipv4' });
    expect(parseNodeAddress('2001:db8::1')).toEqual({ host: '2001:db8::1', port: null, kind: 'ipv6' });
    expect(parseNodeAddress('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: null, kind: 'ipv6' });
    expect(parseNodeAddress('[2001:db8::1]:2000')).toEqual({ host: '2001:db8::1', port: 2000, kind: 'ipv6' });
  });

  it('an unbracketed IPv6 is all address: its last group is not a port', () => {
    expect(parseNodeAddress('2001:db8::1:2000')).toEqual({ host: '2001:db8::1:2000', port: null, kind: 'ipv6' });
    expect(parseNodeAddress('::1')?.host).toBe('::1');
  });

  it('refuses the malformed', () => {
    for (const bad of ['', ' ', '[]', '[::1]:0', '[::1]:65536', ':80', 'host:', 'a:b:c', '1:2:3:4:5:6:7:8:9', '[::1]]']) {
      expect(parseNodeAddress(bad), bad).toBeNull();
    }
  });
});

describe('canonicalIpv6', () => {
  it('writes one spelling: lower-case, the longest zero run compressed', () => {
    expect(canonicalIpv6('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(canonicalIpv6('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(canonicalIpv6('0:0:0:0:0:0:0:0')).toBe('::');
    expect(canonicalIpv6('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    // A single zero group is not compressed (RFC 5952).
    expect(canonicalIpv6('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7');
    expect(canonicalIpv6('::ffff:1.2.3.4')).toBe('::ffff:102:304');
  });

  it('agrees with the URL parser, which the subscription uses', () => {
    for (const a of ['2001:db8::1', 'fe80::1', '::', '1::', '1:0:0:2::3', '2001:db8:0:1:1:1:1:1', '::ffff:10.0.0.1']) {
      expect(canonicalIpv6(a), a).toBe(new URL(`http://[${a}]`).hostname.slice(1, -1));
    }
  });

  it('refuses a non-address and a zone', () => {
    for (const bad of ['', '1:2', ':::', '1::2::3', 'g::1', '12345::1', 'fe80::1%eth0', '1.2.3.4', '::1.2.3']) {
      expect(canonicalIpv6(bad), bad).toBeNull();
    }
    expect(canonicalIpv6Host('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(canonicalIpv6Host('example.com')).toBeNull();
  });
});

describe('canonicalNodeAddress and joinNodeAddress', () => {
  it('names and IPv4 are returned as typed', () => {
    expect(canonicalNodeAddress('Node.Example.com:1337')).toBe('Node.Example.com:1337');
    expect(canonicalNodeAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(canonicalNodeAddress('nope:x')).toBeNull();
  });

  it('IPv6 forms meet in one string', () => {
    expect(canonicalNodeAddress('[2001:db8::1]:1337')).toBe('2001:db8::1');
    expect(canonicalNodeAddress('[2001:db8::1]:7000')).toBe('[2001:db8::1]:7000');
  });

  it('joins a form\'s host and port, bracketing IPv6', () => {
    expect(joinNodeAddress('node.example.com', 1337)).toBe('node.example.com:1337');
    expect(joinNodeAddress('2001:db8::1', 1337)).toBe('[2001:db8::1]:1337');
    expect(joinNodeAddress('[2001:db8::1]', '7000')).toBe('[2001:db8::1]:7000');
  });
});
