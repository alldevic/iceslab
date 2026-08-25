import { describe, expect, it } from 'vitest';
import type { InboundDto, UfwPortDto } from '@iceslab/shared';
import {
  protosForProtocol,
  buildExpectedPortSet,
  computePortExposure,
} from './nodes.exposure.js';

const inbound = (protocol: string, port: number): InboundDto =>
  ({ id: protocol, name: protocol, protocol, port, config: {} }) as unknown as InboundDto;

describe('protosForProtocol (G4)', () => {
  it('udp for hysteria/amneziawg/wireguard, tcp+udp for shadowsocks/mieru, tcp otherwise', () => {
    expect(protosForProtocol('hysteria')).toEqual(['udp']);
    expect(protosForProtocol('amneziawg')).toEqual(['udp']);
    expect(protosForProtocol('wireguard')).toEqual(['udp']);
    expect(protosForProtocol('shadowsocks')).toEqual(['tcp', 'udp']);
    expect(protosForProtocol('mieru')).toEqual(['tcp', 'udp']);
    expect(protosForProtocol('xray')).toEqual(['tcp']);
    expect(protosForProtocol('naive')).toEqual(['tcp']);
  });
});

describe('buildExpectedPortSet (G4)', () => {
  it('always includes SSH, the mTLS agent port, and the ACME helper', () => {
    const set = buildExpectedPortSet([], 1337);
    expect(set.has('22/tcp')).toBe(true);
    expect(set.has('1337/tcp')).toBe(true);
    expect(set.has('80/tcp')).toBe(true);
  });
  it('adds binding ports with the right proto per protocol', () => {
    const set = buildExpectedPortSet(
      [inbound('xray', 443), inbound('hysteria', 8443), inbound('shadowsocks', 9000)],
      1337,
    );
    expect(set.has('443/tcp')).toBe(true); // xray -> tcp
    expect(set.has('8443/udp')).toBe(true); // hysteria -> udp
    expect(set.has('9000/tcp')).toBe(true); // shadowsocks -> tcp + udp
    expect(set.has('9000/udp')).toBe(true);
  });
});

describe('computePortExposure (G4)', () => {
  const allowed: UfwPortDto[] = [
    { port: 22, proto: 'tcp' },
    { port: 443, proto: 'tcp' },
    { port: 1337, proto: 'tcp' },
    { port: 8080, proto: 'tcp' }, // stray
    { port: 5555, proto: 'udp' }, // stray
  ];

  it('reports only the ports outside the expected set, sorted', () => {
    const expected = buildExpectedPortSet([inbound('xray', 443)], 1337);
    expect(computePortExposure(allowed, expected)).toEqual(['5555/udp', '8080/tcp']);
  });

  it('returns nothing when every allowed port is expected', () => {
    const expected = buildExpectedPortSet([inbound('xray', 443)], 1337);
    const clean: UfwPortDto[] = [
      { port: 22, proto: 'tcp' },
      { port: 443, proto: 'tcp' },
      { port: 1337, proto: 'tcp' },
      { port: 80, proto: 'tcp' },
    ];
    expect(computePortExposure(clean, expected)).toEqual([]);
  });
});
