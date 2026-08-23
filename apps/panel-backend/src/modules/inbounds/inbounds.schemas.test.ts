import { describe, expect, it } from 'vitest';
import { ShadowsocksConfigSchema, XrayConfigSchema } from './inbounds.schemas.js';

// U5 post-quantum fields. Two pairs, each half useless without the other:
//   - `realityMldsa65Seed` / `realityMldsa65Verify`
//   - `vlessDecryption`    / `vlessEncryption`
// The contract that keeps every existing profile byte-stable: omitted -> the
// parsed config carries no PQ key at all, so the node renders exactly what it
// rendered before the fields existed.
// (The B1 section of this file stayed behind with its track.)
describe('XrayConfigSchema post-quantum fields (U5)', () => {
  // An ML-DSA-65 public key is 1952 bytes and the schema checks the DECODED
  // length, so any 1952-byte payload stands in for a real one here.
  const VERIFY = Buffer.alloc(1952, 7).toString('base64url');
  const DEC = 'mlkem768x25519plus.native.600s.100-111-1111.75-0-111.50-0-3333.abcXYZ_-';
  const ENC = 'mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111.50-0-3333.abcXYZ_-';

  it('omits every PQ field when absent (preserves pre-U5 wire)', () => {
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'k' });
    expect('realityMldsa65Seed' in cfg).toBe(false);
    expect('realityMldsa65Verify' in cfg).toBe(false);
    expect('vlessDecryption' in cfg).toBe(false);
    expect('vlessEncryption' in cfg).toBe(false);
  });

  it('accepts an ML-DSA-65 pair', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      realityMldsa65Seed: 'SEEDvalue_abc-123+/=',
      realityMldsa65Verify: VERIFY,
    });
    expect(cfg.realityMldsa65Seed).toBe('SEEDvalue_abc-123+/=');
    expect(cfg.realityMldsa65Verify).toBe(VERIFY);
  });

  it('accepts a VLESS-Encryption pair', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      vlessDecryption: DEC,
      vlessEncryption: ENC,
    });
    expect(cfg.vlessDecryption).toBe(DEC);
    expect(cfg.vlessEncryption).toBe(ENC);
  });

  it('rejects a seed/decryption with illegal characters', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', realityMldsa65Seed: 'has space' }),
    ).toThrow();
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', vlessDecryption: 'semi;colon' }),
    ).toThrow();
  });

  // The whole point of the client half: a server-only VLESS-Encryption profile
  // is one whose every user is disconnected the moment it is saved.
  it('refuses a decryption string with no encryption string', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', vlessDecryption: DEC }),
    ).toThrow(/client half/);
  });

  it('refuses an encryption string with no decryption string', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', vlessEncryption: ENC }),
    ).toThrow(/server half/);
  });

  // A seed with no verify key connects fine and verifies nothing, which is the
  // failure mode that hides.
  it('refuses a seed with no verify key', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'k',
        realityMldsa65Seed: 'SEEDvalue',
      }),
    ).toThrow(/verify key/);
  });

  it('refuses a verify key with no seed', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'k', realityMldsa65Verify: VERIFY }),
    ).toThrow(/server seed/);
  });

  // Both halves are present, just in the wrong fields - the state a copy-paste
  // from a two-line keygen output lands in, and one no length check catches.
  it('catches the two VLESS-Encryption halves swapped', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'k',
        vlessDecryption: ENC,
        vlessEncryption: DEC,
      }),
    ).toThrow(/client half/);
  });

  it('lets a grammar it does not recognise through rather than guessing', () => {
    const future = 'mlkem768x25519plus.native.somethingnew.AAAA';
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      vlessDecryption: future,
      vlessEncryption: future,
    });
    expect(cfg.vlessDecryption).toBe(future);
  });

  // `xray vlessenc` prints two complete pairs in one run - X25519 and
  // ML-KEM-768 - and says not to mix them. One half from each is well-formed,
  // passes every shape check, and fails the handshake with nothing to read.
  it('catches halves taken from the two different authentications', () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64url');
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'k',
        vlessDecryption: `mlkem768x25519plus.native.600s.${b64(64)}`, // post-quantum
        vlessEncryption: `mlkem768x25519plus.native.0rtt.${b64(32)}`, // X25519
      }),
    ).toThrow(/different authentications/);
  });

  it('accepts a matched post-quantum pair', () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64url');
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'k',
      vlessDecryption: `mlkem768x25519plus.native.600s.${b64(64)}`,
      vlessEncryption: `mlkem768x25519plus.native.0rtt.${b64(1184)}`,
    });
    expect(cfg.vlessEncryption).toContain('0rtt');
  });

  it('refuses a verify key of the wrong length', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'k',
        realityMldsa65Seed: 'SEEDvalue',
        realityMldsa65Verify: Buffer.alloc(1951, 7).toString('base64url'),
      }),
    ).toThrow(/1952/);
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
