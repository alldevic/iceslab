import { describe, expect, it } from 'vitest';
import type { Node } from '../../generated/prisma/client.js';
import { mapNodeToPublic } from './nodes.mapper.js';

function row(hardening: unknown): Node {
  const now = new Date('2026-11-27T00:00:00Z');
  return {
    id: 'n1',
    name: 'n1',
    address: 'n1.test',
    protocol: 'xray',
    status: 'disabled',
    consumptionMultiplierTenths: 10,
    intendedEngines: ['xray'],
    singboxEngine: false,
    warpEnabled: false,
    hardening,
    createdAt: now,
    updatedAt: now,
  } as unknown as Node;
}

describe('mapNodeToPublic and the hardening blob', () => {
  it('hands out the cold-pool labels next to the install flags', () => {
    const pool = { spare: true, asn: 'AS24940', provider: 'hetzner', burned: false };
    expect(mapNodeToPublic(row({ fail2ban: true, pool })).hardening).toEqual({ fail2ban: true, pool });
  });

  it('an empty blob is null', () => {
    expect(mapNodeToPublic(row(null)).hardening).toBeNull();
    expect(mapNodeToPublic(row(undefined)).hardening).toBeNull();
  });
});

describe('mapNodeToPublic and deferredDns (19.15: what the node left out)', () => {
  const withConflicts = (v: unknown): Node => ({ ...row(null), presetDnsConflicts: v }) as unknown as Node;

  it('is an empty list when nothing was left out, whatever the column holds', () => {
    expect(mapNodeToPublic(withConflicts(null)).deferredDns).toEqual([]);
    expect(mapNodeToPublic(withConflicts(undefined)).deferredDns).toEqual([]);
    expect(mapNodeToPublic(withConflicts({ not: 'a list' })).deferredDns).toEqual([]);
  });

  it('carries both kinds: a clash with another source and a preset left out by the 16-server limit', () => {
    const dto = mapNodeToPublic(
      withConflicts([
        { kind: 'conflict', presetId: 'b', otherPresetId: 'a', domain: 'example.com', server: '10.0.0.2' },
        { kind: 'conflict', presetId: 'c', otherPresetId: null, domain: 'geosite:x', server: '10.0.0.3' },
        { kind: 'limit', presetId: 'd', count: 19 },
      ]),
    );
    expect(dto.deferredDns).toEqual([
      { kind: 'conflict', presetId: 'b', otherPresetId: 'a', domain: 'example.com', server: '10.0.0.2' },
      { kind: 'conflict', presetId: 'c', otherPresetId: null, domain: 'geosite:x', server: '10.0.0.3' },
      { kind: 'limit', presetId: 'd', count: 19 },
    ]);
  });
});
