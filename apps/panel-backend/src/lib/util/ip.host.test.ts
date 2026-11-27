import { describe, expect, it } from 'vitest';
import { hostPort, isIpv6Literal, normalizeHost } from './ip.js';

describe('normalizeHost', () => {
  it('leaves a name byte for byte, case included', () => {
    expect(normalizeHost('Node-1.Example.com')).toBe('Node-1.Example.com');
  });
  it('leaves IPv4 alone', () => {
    expect(normalizeHost('203.0.113.7')).toBe('203.0.113.7');
  });
  it('keeps a bare IPv6 bare', () => {
    expect(normalizeHost('2001:db8::1')).toBe('2001:db8::1');
  });
  it('strips the brackets of an IPv6 literal', () => {
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1');
  });
  it('lower-cases and compresses an IPv6 literal, either spelling', () => {
    expect(normalizeHost('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeHost('[2001:0db8::0001]')).toBe('2001:db8::1');
  });
  it('does not touch a zone-qualified address beyond the brackets', () => {
    expect(normalizeHost('fe80::1%eth0')).toBe('fe80::1%eth0');
    expect(normalizeHost('[fe80::1%eth0]')).toBe('fe80::1%eth0');
  });
  it('returns a string that is not an address as given', () => {
    expect(normalizeHost('not an address:::')).toBe('not an address:::');
    expect(normalizeHost('')).toBe('');
  });
});

describe('hostPort', () => {
  it('joins a name and IPv4 as before', () => {
    expect(hostPort('n.example.com', 443)).toBe('n.example.com:443');
    expect(hostPort('203.0.113.7', 8443)).toBe('203.0.113.7:8443');
  });
  it('brackets IPv6, whichever way it arrives', () => {
    expect(hostPort('2001:db8::1', 443)).toBe('[2001:db8::1]:443');
    expect(hostPort('[2001:DB8::1]', 443)).toBe('[2001:db8::1]:443');
  });
});

describe('isIpv6Literal', () => {
  it('is true only for IPv6', () => {
    expect(isIpv6Literal('[2001:db8::1]')).toBe(true);
    expect(isIpv6Literal('2001:db8::1')).toBe(true);
    expect(isIpv6Literal('203.0.113.7')).toBe(false);
    expect(isIpv6Literal('n.example.com')).toBe(false);
  });
});
