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
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE' });
    expect('realityMldsa65Seed' in cfg).toBe(false);
    expect('realityMldsa65Verify' in cfg).toBe(false);
    expect('vlessDecryption' in cfg).toBe(false);
    expect('vlessEncryption' in cfg).toBe(false);
  });

  it('accepts an ML-DSA-65 pair', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
      realityMldsa65Seed: 'SEEDvalue_abc-123+/=',
      realityMldsa65Verify: VERIFY,
    });
    expect(cfg.realityMldsa65Seed).toBe('SEEDvalue_abc-123+/=');
    expect(cfg.realityMldsa65Verify).toBe(VERIFY);
  });

  it('accepts a VLESS-Encryption pair', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
      vlessDecryption: DEC,
      vlessEncryption: ENC,
    });
    expect(cfg.vlessDecryption).toBe(DEC);
    expect(cfg.vlessEncryption).toBe(ENC);
  });

  it('rejects a seed/decryption with illegal characters', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', realityMldsa65Seed: 'has space' }),
    ).toThrow();
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', vlessDecryption: 'semi;colon' }),
    ).toThrow();
  });

  // The whole point of the client half: a server-only VLESS-Encryption profile
  // is one whose every user is disconnected the moment it is saved.
  it('refuses a decryption string with no encryption string', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', vlessDecryption: DEC }),
    ).toThrow(/client half/);
  });

  it('refuses an encryption string with no decryption string', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', vlessEncryption: ENC }),
    ).toThrow(/server half/);
  });

  // A seed with no verify key connects fine and verifies nothing, which is the
  // failure mode that hides.
  it('refuses a seed with no verify key', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        realityMldsa65Seed: 'SEEDvalue',
      }),
    ).toThrow(/verify key/);
  });

  it('refuses a verify key with no seed', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', realityMldsa65Verify: VERIFY }),
    ).toThrow(/server seed/);
  });

  // Both halves are present, just in the wrong fields - the state a copy-paste
  // from a two-line keygen output lands in, and one no length check catches.
  it('catches the two VLESS-Encryption halves swapped', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        vlessDecryption: ENC,
        vlessEncryption: DEC,
      }),
    ).toThrow(/client half/);
  });

  it('lets a grammar it does not recognise through rather than guessing', () => {
    const future = 'mlkem768x25519plus.native.somethingnew.AAAA';
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
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
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        vlessDecryption: `mlkem768x25519plus.native.600s.${b64(64)}`, // post-quantum
        vlessEncryption: `mlkem768x25519plus.native.0rtt.${b64(32)}`, // X25519
      }),
    ).toThrow(/different authentications/);
  });

  it('accepts a matched post-quantum pair', () => {
    const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64url');
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
      vlessDecryption: `mlkem768x25519plus.native.600s.${b64(64)}`,
      vlessEncryption: `mlkem768x25519plus.native.0rtt.${b64(1184)}`,
    });
    expect(cfg.vlessEncryption).toContain('0rtt');
  });

  it('refuses a verify key of the wrong length', () => {
    expect(() =>
      XrayConfigSchema.parse({
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
        realityMldsa65Seed: 'SEEDvalue',
        realityMldsa65Verify: Buffer.alloc(1951, 7).toString('base64url'),
      }),
    ).toThrow(/1952/);
  });
});

// The REALITY keypair is base64url of 32 bytes and nothing else. A key in the
// WireGuard alphabet is what a generate-keypair call for the wrong protocol
// hands you, and xray refuses it: the profile saves, the push fails, and the
// only explanation is a line in the node's journal.
describe('XrayConfigSchema REALITY keypair alphabet', () => {
  const OK = 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE';

  it('accepts a base64url key', () => {
    expect(XrayConfigSchema.parse({ realityPrivateKey: OK }).realityPrivateKey).toBe(OK);
  });

  it('keeps empty as the not-configured-yet state', () => {
    expect(XrayConfigSchema.parse({}).realityPrivateKey).toBe('');
  });

  it('refuses a standard-base64 (WireGuard) key', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPrivateKey: 'sKOls49SJiDfgZS3yEbgiQnG8xAy2S3+uSFJSCckpXA=' }),
    ).toThrow(/base64url/);
  });

  it('refuses a truncated key', () => {
    expect(() => XrayConfigSchema.parse({ realityPrivateKey: OK.slice(0, 42) })).toThrow(/43/);
  });

  it('guards the public key the same way (it goes out as pbk= in every link)', () => {
    expect(() =>
      XrayConfigSchema.parse({ realityPublicKey: 'NY875Kr+MVKvq4DbDLtN7aAVysX7RYUrIVAW6M65OVk=' }),
    ).toThrow(/base64url/);
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
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE' });
    expect('abusePolicy' in cfg).toBe(false);
    expect(cfg.abusePolicy).toBeUndefined();
  });

  it('defaults every flag to true when the object is present but empty', () => {
    const cfg = XrayConfigSchema.parse({ realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE', abusePolicy: {} });
    expect(cfg.abusePolicy).toEqual({
      blockTorrent: true,
      blockSmtp: true,
      blockDnsHijack: true,
    });
  });

  it('fills the unspecified flags with true when one is flipped', () => {
    const cfg = XrayConfigSchema.parse({
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
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
      realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
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
        realityPrivateKey: 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE',
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
