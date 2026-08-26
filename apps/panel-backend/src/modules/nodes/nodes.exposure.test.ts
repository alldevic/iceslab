import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboundDto, ProtocolName, UfwPortDto } from '@iceslab/shared';
import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas.js';
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

/**
 * The other half of this decision lives in Go: the node opens the ports
 * (`protoForInbound` in internal/server/server.go) while this file decides
 * which allowed ports are EXPECTED. The comment above `protosForProtocol` has
 * always said it mirrors server.go, and a comment is not a check.
 *
 * A divergence is quiet in both directions: a proto the node opens and this
 * side does not expect is reported to the operator as a stray port on a clean
 * node — the exact noise the exposure feature exists to remove — and a proto
 * this side expects but the node never opens hides a real one.
 *
 * The vectors are shared and the Go side reads the same file, so a change on
 * either side reddens on that side.
 */
describe('the ufw proto contract with the node agent', () => {
  const VECTORS = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'shared',
    'testdata',
    'inbound-proto-vectors.json',
  );
  const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
    vectors: { protocol: string; protos: ('tcp' | 'udp')[] }[];
  };

  it('the fixture is there and shaped like a fixture', () => {
    // The control: an empty or reshaped file would make the case below pass by
    // having nothing to compare, which is how a mirror test dies quietly.
    expect(doc.vectors.length).toBeGreaterThanOrEqual(11);
    for (const v of doc.vectors) {
      expect(v.protos.length, `${v.protocol} lists no proto`).toBeGreaterThan(0);
    }
  });

  it('answers what the node opens, for every vector', () => {
    for (const v of doc.vectors) {
      expect([...protosForProtocol(v.protocol)].sort(), v.protocol).toEqual([...v.protos].sort());
    }
  });

  // The registry above is the live list of protocols the panel accepts, and
  // this line is what keeps it equal to the ProtocolName union the node shares:
  // a member added to the type with no schema fails the typecheck here rather
  // than silently shrinking what the case below considers "every protocol".
  const _schemasCoverTheUnion: Record<ProtocolName, unknown> = PROTOCOL_CONFIG_SCHEMAS;
  void _schemasCoverTheUnion;

  it('covers every protocol the system knows', () => {
    // Without this a protocol added to one switch and not the other would pass
    // simply by being absent from the fixture, which is the failure the
    // fixture exists to prevent.
    const listed = doc.vectors.map((v) => v.protocol).sort();
    expect(listed).toEqual(Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort());
  });
});
