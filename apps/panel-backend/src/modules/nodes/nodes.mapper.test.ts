import { describe, expect, it } from 'vitest';
import { mapNodeToPublic } from './nodes.mapper.js';
import type { Node } from '../../generated/prisma/client.js';

/**
 * A node update REPLACES the hardening blob, and the edit form builds what it
 * sends from this DTO. So every key that lives in that blob has to come OUT of
 * here, or the form cannot send it back and saving a node deletes it.
 *
 * That is not hypothetical: the wizard's four toggles were the only keys the
 * DTO carried, so opening the node form and pressing save wiped the F2 pool
 * labels, and would have wiped the egress policy and the zapret2 channel with
 * them.
 */
function nodeRow(hardening: unknown): Node {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    sourceId: null,
    name: 'n1',
    address: 'n1.example:1337',
    protocol: 'xray',
    publicKey: null,
    countryCode: null,
    status: 'online',
    lastStatusChange: null,
    lastStatusMessage: null,
    coreVersion: null,
    coreRestarts: null,
    egressTune: null,
    lastInboundSyncAt: null,
    consumptionMultiplier: 1n,
    regionId: null,
    maxUsers: null,
    domain: null,
    hardening,
    warpEnabled: false,
    warpAccount: null,
    singboxEngine: false,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    updatedAt: new Date('2026-08-23T00:00:00Z'),
  } as unknown as Node;
}

describe('mapNodeToPublic hardening', () => {
  it('carries every per-node subsystem key, not just the wizard toggles', () => {
    const stored = {
      ufwLockdown: true,
      pool: { asn: 'AS12345', provider: 'acme' },
      egressPolicy: [{ geosite: ['ru'], target: 'direct' }],
      zapret2: { enabled: true, preset: 'rf-default' },
    };
    expect(mapNodeToPublic(nodeRow(stored)).hardening).toEqual(stored);
  });

  it('reports no hardening as null', () => {
    expect(mapNodeToPublic(nodeRow(null)).hardening).toBeNull();
  });
});
