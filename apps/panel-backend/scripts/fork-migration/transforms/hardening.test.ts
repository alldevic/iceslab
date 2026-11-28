import { describe, expect, it } from 'vitest';
import { HardeningSchema } from '../../../src/modules/nodes/nodes.schemas.js';
import { stripHardening } from './hardening.js';
import { stripLossy } from './loss.js';

describe('hardening of the old fork', () => {
  const old = {
    ufwLockdown: true,
    fail2ban: true,
    sshAllowlist: ['10.0.0.1'],
    pool: { asn: 'AS1', provider: 'acme', burned: false },
    egressPolicy: [{ geosite: ['ru'], target: 'direct' }],
    zapret2: { enabled: true },
    bridgeNonXrayInbounds: true,
  };

  it('is refused by the strict schema of the new fork until the three keys are out (a PUT of the node would answer 400)', () => {
    expect(HardeningSchema.safeParse(old).success).toBe(false);
    const s = stripHardening(old)!;
    expect(HardeningSchema.safeParse(s.next).success).toBe(true);
    expect(Object.keys(s.removed).sort()).toEqual(['bridgeNonXrayInbounds', 'egressPolicy', 'zapret2']);
    expect(s.next).toEqual({ ufwLockdown: true, fail2ban: true, sshAllowlist: ['10.0.0.1'], pool: { asn: 'AS1', provider: 'acme', burned: false } });
  });

  it('leaves a hardening without those keys, and a missing one, alone', () => {
    expect(stripHardening({ fail2ban: true })).toBeNull();
    expect(stripHardening(null)).toBeNull();
  });
});

describe('--accept-loss', () => {
  it('takes the fields the new fork dropped out of a stored config and only those', () => {
    const r = stripLossy({ realityMldsa65Seed: 's', realityMldsa65Verify: 'v', vlessDecryption: 'd', vlessEncryption: 'e', abusePolicy: { blockSmtp: true }, realityDest: 'x:443' })!;
    expect(r.removed.sort()).toEqual(['abusePolicy', 'realityMldsa65Seed', 'realityMldsa65Verify', 'vlessDecryption', 'vlessEncryption']);
    expect(r.next).toEqual({ realityDest: 'x:443' });
    expect(stripLossy({ realityDest: 'x:443' })).toBeNull();
    expect(stripLossy(null)).toBeNull();
  });
});
