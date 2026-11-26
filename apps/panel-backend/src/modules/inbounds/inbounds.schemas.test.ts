import { describe, expect, it } from 'vitest';
import { AmneziawgConfigSchema, REALITY_TRANSPORTS, XrayConfigSchema } from './inbounds.schemas.js';

const base = {
  subnet: '10.66.66.0/24',
  serverPrivateKey: 'priv',
  serverPublicKey: 'pub',
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
