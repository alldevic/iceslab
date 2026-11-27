import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_NAMES, type InboundDto, type ProtocolName, type UfwPortDto } from '@iceslab/shared';
import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas.js';
import {
  protosForProtocol,
  buildExpectedPortSet,
  computePortExposure,
} from './nodes.exposure.js';

const inbound = (protocol: string, port: number): InboundDto =>
  ({ id: protocol, name: protocol, protocol, port, config: {} }) as unknown as InboundDto;

describe('protosForProtocol (G4)', () => {
  it('udp for hysteria/amneziawg, tcp+udp for shadowsocks/mieru, tcp otherwise', () => {
    expect(protosForProtocol('hysteria')).toEqual(['udp']);
    expect(protosForProtocol('amneziawg')).toEqual(['udp']);
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

/**
 * The other half of this decision lives in Go: the node opens the ports
 * (`protoForInbound` in apps/node/internal/server/server.go) while this file
 * decides which allowed ports are EXPECTED. A divergence is quiet in both
 * directions: a stray port reported on a clean node, or a real one hidden.
 * The vectors are shared and the Go side reads the same file, so a change on
 * either side reddens on that side.
 */
describe('the ufw proto contract with the node agent', () => {
  const VECTORS = join(
    import.meta.dirname,
    '..', '..', '..', '..', '..',
    'packages', 'shared', 'testdata', 'inbound-proto-vectors.json',
  );
  const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
    vectors: { protocol: string; protos: ('tcp' | 'udp')[] }[];
  };

  it('the fixture is there and shaped like a fixture', () => {
    // The control: an empty or reshaped file would make the case below pass by
    // having nothing to compare.
    expect(doc.vectors.length).toBeGreaterThanOrEqual(10);
    for (const v of doc.vectors) {
      expect(v.protos.length, `${v.protocol} lists no proto`).toBeGreaterThan(0);
    }
  });

  it('answers what the node opens, for every vector', () => {
    for (const v of doc.vectors) {
      expect([...protosForProtocol(v.protocol)].sort(), v.protocol).toEqual([...v.protos].sort());
    }
  });

  // Keeps the schema registry equal to the ProtocolName union the node shares.
  const _schemasCoverTheUnion: Record<ProtocolName, unknown> = PROTOCOL_CONFIG_SCHEMAS;
  void _schemasCoverTheUnion;

  it('covers every name in PROTOCOL_NAMES exactly once', () => {
    // A protocol added to one switch and not the other would otherwise pass by
    // being absent from the fixture.
    // The `wireguard` row is added together with the protocol itself (stage 9).
    const listed = doc.vectors.map((v) => v.protocol).sort();
    expect(listed).toEqual([...PROTOCOL_NAMES].sort());
  });
});

describe('the agent port of a node address', () => {
  it('is read from host:port and [v6]:port, 1337 when the address has none', async () => {
    const { agentPortOf } = await import('./nodes.exposure.js');
    expect(agentPortOf('node.example.com')).toBe(1337);
    expect(agentPortOf('node.example.com:8443')).toBe(8443);
    expect(agentPortOf('2001:db8::1')).toBe(1337);
    expect(agentPortOf('[2001:db8::1]')).toBe(1337);
    expect(agentPortOf('[2001:db8::1]:8443')).toBe(8443);
  });
});
