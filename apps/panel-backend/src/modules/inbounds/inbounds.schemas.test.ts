import { describe, expect, it } from 'vitest';
import { XrayConfigSchema } from './inbounds.schemas.js';

// U5 post-quantum fields. The contract that keeps every existing profile
// byte-stable: omitted → the parsed config carries no PQ key at all, so the
// node renders exactly what it rendered before the fields existed.
// (The U4/B1 sections of this file stayed behind with their tracks.)
describe('XrayConfigSchema post-quantum fields (U5)', () => {
  it('omits both PQ fields when absent (preserves pre-U5 wire)', () => {
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'k' });
    expect('realityMldsa65Seed' in cfg).toBe(false);
    expect('vlessDecryption' in cfg).toBe(false);
  });

  it('accepts an ML-DSA-65 seed', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      realityMldsa65Seed: 'SEEDvalue_abc-123+/=',
    });
    expect(cfg.realityMldsa65Seed).toBe('SEEDvalue_abc-123+/=');
  });

  it('accepts a VLESS-Encryption decryption string', () => {
    const dec = 'mlkem768x25519plus.native.600s.100-111-1111.75-0-111.50-0-3333.abcXYZ_-';
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'k', vlessDecryption: dec });
    expect(cfg.vlessDecryption).toBe(dec);
  });

  it('rejects a seed/decryption with illegal characters', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', realityMldsa65Seed: 'has space' }),
    ).toThrow();
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', vlessDecryption: 'semi;colon' }),
    ).toThrow();
  });
});
