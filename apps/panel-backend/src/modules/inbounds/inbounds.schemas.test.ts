import { describe, expect, it } from 'vitest';
import { ShadowsocksConfigSchema, XrayConfigSchema } from './inbounds.schemas.js';

// U5 post-quantum fields. The contract that keeps every existing profile
// byte-stable: omitted → the parsed config carries no PQ key at all, so the
// node renders exactly what it rendered before the fields existed.
// (The B1 section of this file stayed behind with its track.)
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

// U4 configurable anti-abuse. The `abusePolicy` object gates the node's
// built-in xray BLOCK rules. The schema contract that keeps existing profiles
// byte-stable on the wire:
//   - omitted  → parsed config has NO abusePolicy key (nothing sent → node
//                enables all rules, byte-identical to pre-U4)
//   - present  → each flag defaults to true, so the wire always carries a
//                fully-specified policy and the operator flips only what they
//                want to relax.
describe('XrayConfigSchema abusePolicy (U4)', () => {
  it('is absent from the parsed config when omitted (preserves pre-U4 wire)', () => {
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'k' });
    expect('abusePolicy' in cfg).toBe(false);
    expect(cfg.abusePolicy).toBeUndefined();
  });

  it('defaults every flag to true when the object is present but empty', () => {
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'k', abusePolicy: {} });
    expect(cfg.abusePolicy).toEqual({
      blockTorrent: true,
      blockSmtp: true,
      blockDnsHijack: true,
    });
  });

  it('fills the unspecified flags with true when one is flipped', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      abusePolicy: { blockTorrent: false },
    });
    expect(cfg.abusePolicy).toEqual({
      blockTorrent: false,
      blockSmtp: true,
      blockDnsHijack: true,
    });
  });

  it('preserves a fully-specified policy', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      abusePolicy: { blockTorrent: false, blockSmtp: false, blockDnsHijack: false },
    });
    expect(cfg.abusePolicy).toEqual({
      blockTorrent: false,
      blockSmtp: false,
      blockDnsHijack: false,
    });
  });

  it('rejects a non-boolean flag', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'k',
        // @ts-expect-error - intentionally wrong type
        abusePolicy: { blockTorrent: 'yes' },
      }),
    ).toThrow();
  });
});

// The shadowsocks core renders the same BLOCK rules as the xray core, so it
// takes the same policy with the same absent-means-all-enabled contract.
describe('ShadowsocksConfigSchema abusePolicy (U4)', () => {
  it('is absent from the parsed config when omitted (preserves pre-U4 wire)', () => {
    const cfg = ShadowsocksConfigSchema.parse({ serverPsk: 'psk' });
    expect('abusePolicy' in cfg).toBe(false);
  });

  it('fills the unspecified flags with true when one is flipped', () => {
    const cfg = ShadowsocksConfigSchema.parse({
      serverPsk: 'psk',
      abusePolicy: { blockTorrent: false },
    });
    expect(cfg.abusePolicy).toEqual({
      blockTorrent: false,
      blockSmtp: true,
      blockDnsHijack: true,
    });
  });

  it('rejects a non-boolean flag', () => {
    expect(() =>
      ShadowsocksConfigSchema.parse({
        serverPsk: 'psk',
        // @ts-expect-error - intentionally wrong type
        abusePolicy: { blockSmtp: 'no' },
      }),
    ).toThrow();
  });
});
