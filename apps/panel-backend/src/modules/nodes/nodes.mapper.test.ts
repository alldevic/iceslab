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
