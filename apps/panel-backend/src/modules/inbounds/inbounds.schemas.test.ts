import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AmneziawgConfigSchema, REALITY_TRANSPORTS, XrayConfigSchema } from './inbounds.schemas.js';
import { WG_TEST_PRIVATE_KEY, WG_TEST_PUBLIC_KEY } from '../../../tests/helpers/wg-keys.js';

const base = {
  subnet: '10.66.66.0/24',
  serverPrivateKey: WG_TEST_PRIVATE_KEY,
  serverPublicKey: WG_TEST_PUBLIC_KEY,
};

describe('AmneziawgConfigSchema S3/S4', () => {
  it('a profile without s3/s4 is saved with zeros (1.x clients)', () => {
    const parsed = AmneziawgConfigSchema.parse({ ...base, obfuscation: {} });
    expect(parsed.obfuscation.s3).toBe(0);
    expect(parsed.obfuscation.s4).toBe(0);
  });

  it('explicit values are kept', () => {
    const parsed = AmneziawgConfigSchema.parse({ ...base, obfuscation: { s3: 32, s4: 16 } });
    expect(parsed.obfuscation.s3).toBe(32);
    expect(parsed.obfuscation.s4).toBe(16);
  });
});

describe('AmneziawgConfigSchema server keys: the shape the node enforces', () => {
  const parse = (priv: string, pub: string = WG_TEST_PUBLIC_KEY) =>
    AmneziawgConfigSchema.safeParse({ ...base, serverPrivateKey: priv, serverPublicKey: pub, obfuscation: {} });

  it('takes 44 characters of standard base64 ending in =', () => {
    expect(parse(WG_TEST_PRIVATE_KEY).success).toBe(true);
    expect(parse('a'.repeat(43) + '=').success).toBe(true);
    expect(parse(`${'+/'.repeat(21)}A=`).success).toBe(true);
  });

  // validateWGKey (apps/node/internal/core/amneziawg/config.go): 44 chars that
  // decode to 32 bytes. Each of these it refuses, so the schema must.
  it.each([
    ['without the padding', 'a'.repeat(44)],
    ['too short', 'a'.repeat(42) + '='],
    ['too long', 'a'.repeat(44) + '='],
    ['empty', ''],
    ['a placeholder', 'PRIV'],
    ['base64url, not the standard alphabet', '-_'.repeat(21) + 'A='],
    ['padded twice', 'a'.repeat(42) + '=='],
    ['with a space inside', 'a'.repeat(21) + ' ' + 'a'.repeat(21) + '='],
  ])('refuses a key %s, on the field', (_name, key) => {
    const r = parse(key);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['serverPrivateKey']);
    const pub = parse(WG_TEST_PRIVATE_KEY, key);
    expect(pub.success).toBe(false);
    if (!pub.success) expect(pub.error.issues[0]?.path).toEqual(['serverPublicKey']);
  });

  it('keeps the node rule it mirrors: 44 characters, 32 bytes', () => {
    const go = readFileSync(
      fileURLToPath(new URL('../../../../node/internal/core/amneziawg/config.go', import.meta.url)),
      'utf8',
    );
    expect(go).toMatch(/len\(s\) != 44/);
    expect(go).toMatch(/len\(raw\) != 32/);
  });
});

describe('AmneziawgConfigSchema Jmin <= Jmax', () => {
  const parse = (jmin: number, jmax: number) =>
    AmneziawgConfigSchema.safeParse({ ...base, obfuscation: { jmin, jmax } });

  it('refuses Jmin above Jmax, with the path to jmax', () => {
    const r = parse(129, 128);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path)).toEqual([['obfuscation', 'jmax']]);
  });

  it('takes Jmin equal to Jmax and below it', () => {
    expect(parse(128, 128).success).toBe(true);
    expect(parse(64, 128).success).toBe(true);
  });

  it('keeps the node rule it mirrors', () => {
    const go = readFileSync(
      fileURLToPath(new URL('../../../../node/internal/core/amneziawg/config.go', import.meta.url)),
      'utf8',
    );
    expect(go).toMatch(/c\.Jmin > c\.Jmax/);
  });

  it('the defaults of a profile that names neither pass (3.1 keeps its own geometry)', () => {
    expect(AmneziawgConfigSchema.safeParse({ ...base, obfuscation: {} }).success).toBe(true);
  });
});

// A key REALITY's own decoder takes: base64url of 32 bytes, 43 characters.
const REALITY_KEY = 'YAT-bEESM0kh2iD3ujUlW1SQ-HeGjigNdYRs8B5ZSEE';

describe('XrayConfigSchema REALITY key shape', () => {
  const parse = (k: string) =>
    XrayConfigSchema.safeParse({ realityPrivateKey: k, realityPublicKey: k });

  it('accepts an empty key (not configured yet) and a 43-char base64url key', () => {
    expect(parse('').success).toBe(true);
    expect(parse(REALITY_KEY).success).toBe(true);
  });

  it('refuses a short key, a wrong alphabet, and padding', () => {
    expect(parse(REALITY_KEY.slice(0, 42)).success).toBe(false);
    expect(parse(`${REALITY_KEY}A`).success).toBe(false);
    expect(parse(`${REALITY_KEY.slice(0, 41)}+/`).success).toBe(false);
    expect(parse(`${REALITY_KEY.slice(0, 42)}=`).success).toBe(false);
  });

  it('names the field on each side', () => {
    const r = XrayConfigSchema.safeParse({ realityPrivateKey: 'k', realityPublicKey: 'p' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path[0]).sort()).toEqual([
        'realityPrivateKey',
        'realityPublicKey',
      ]);
    }
  });
});

describe('XrayConfigSchema REALITY carries only the transports xray will load', () => {
  // Measured on xray 26.3.27: ws / kcp -> `infra/conf: REALITY only supports
  // RAW, XHTTP and gRPC for now.` Bound to a node, the saved config sent the
  // core into a restart loop.
  const cfg = (security: string, network: string) => ({
    realityPrivateKey: REALITY_KEY,
    security,
    network,
  });

  it('accepts raw, xhttp and grpc', () => {
    for (const n of REALITY_TRANSPORTS) {
      expect(XrayConfigSchema.safeParse(cfg('reality', n)).success, n).toBe(true);
    }
  });

  it('refuses ws, httpupgrade and kcp, and says why', () => {
    for (const n of ['ws', 'httpupgrade', 'kcp']) {
      const r = XrayConfigSchema.safeParse(cfg('reality', n));
      expect(r.success, n).toBe(false);
      if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('REALITY carries only');
    }
  });

  it('leaves non-REALITY security alone: TLS and none on every transport', () => {
    for (const sec of ['tls', 'none']) {
      for (const n of ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp']) {
        expect(XrayConfigSchema.safeParse(cfg(sec, n)).success, `${sec}+${n}`).toBe(true);
      }
    }
  });

  it('the legacy "tcp" spelling is normalised before the rule reads it', () => {
    expect(XrayConfigSchema.safeParse(cfg('reality', 'tcp')).success).toBe(true);
  });
});
