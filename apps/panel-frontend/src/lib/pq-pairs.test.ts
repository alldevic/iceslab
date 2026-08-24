import { describe, expect, it } from 'vitest';
import {
  PQ_FIELDS,
  pqPairError,
  pqPairErrors,
  type PqField,
  type PqFormValues,
} from './pq-pairs';
import en from '../i18n/locales/en';
import ru from '../i18n/locales/ru';

/** An xray/reality/vless profile with no PQ material - the state every case
 *  below starts from, so a rule that fires here fires on every new profile. */
const base: PqFormValues = {
  protocol: 'xray',
  xraySecurity: 'reality',
  xraySubprotocol: 'vless',
  xrayMldsa65Seed: '',
  xrayMldsa65Verify: '',
  xrayVlessDecryption: '',
  xrayVlessEncryption: '',
};

const SEED = 'FbUuTGwFDMOn2ptl9CyMBFQrOTeoHTAJpVnT9RHwXpk';
// An ML-DSA-65 public key is 1952 bytes; the backend checks that length, and
// the fixture is built to it so the two halves of the gate agree on shape.
const VERIFY = Buffer.alloc(1952, 0x41).toString('base64');
const DECRYPTION = 'mlkem768x25519plus.native.600s.' + 'b'.repeat(88);
const ENCRYPTION = 'mlkem768x25519plus.native.0rtt.' + 'c'.repeat(1580);

describe('the four pair rules', () => {
  it('says nothing about an empty profile', () => {
    expect(pqPairErrors(base)).toEqual({});
  });

  it('says nothing when both halves of both pairs are there', () => {
    expect(
      pqPairErrors({
        ...base,
        xrayMldsa65Seed: SEED,
        xrayMldsa65Verify: VERIFY,
        xrayVlessDecryption: DECRYPTION,
        xrayVlessEncryption: ENCRYPTION,
      }),
    ).toEqual({});
  });

  it('a REALITY seed without a verify key blames the verify field', () => {
    expect(pqPairErrors({ ...base, xrayMldsa65Seed: SEED })).toEqual({
      xrayMldsa65Verify: 'profiles.form.cfg.pqNeedsVerify',
    });
  });

  it('a verify key without a seed blames the seed field', () => {
    expect(pqPairErrors({ ...base, xrayMldsa65Verify: VERIFY })).toEqual({
      xrayMldsa65Seed: 'profiles.form.cfg.pqNeedsSeed',
    });
  });

  it('a decryption string without its client half blames the encryption field', () => {
    expect(pqPairErrors({ ...base, xrayVlessDecryption: DECRYPTION })).toEqual({
      xrayVlessEncryption: 'profiles.form.cfg.pqNeedsEncryption',
    });
  });

  it('an encryption string without its server half blames the decryption field', () => {
    expect(pqPairErrors({ ...base, xrayVlessEncryption: ENCRYPTION })).toEqual({
      xrayVlessDecryption: 'profiles.form.cfg.pqNeedsDecryption',
    });
  });

  it('both pairs can be half-filled at once and both are reported', () => {
    expect(
      pqPairErrors({ ...base, xrayMldsa65Seed: SEED, xrayVlessEncryption: ENCRYPTION }),
    ).toEqual({
      xrayMldsa65Verify: 'profiles.form.cfg.pqNeedsVerify',
      xrayVlessDecryption: 'profiles.form.cfg.pqNeedsDecryption',
    });
  });

  // The submit builder trims before emitting, so a box holding only a newline
  // sends nothing. If the rules disagreed, the form would happily save the very
  // half-pair the backend is about to reject.
  it('whitespace is not a value on either side of a pair', () => {
    expect(pqPairErrors({ ...base, xrayMldsa65Seed: SEED, xrayMldsa65Verify: '  \n ' })).toEqual({
      xrayMldsa65Verify: 'profiles.form.cfg.pqNeedsVerify',
    });
    expect(pqPairErrors({ ...base, xrayMldsa65Seed: '\t' })).toEqual({});
  });
});

describe('where the pairs do and do not apply', () => {
  // The submit builder emits realityMldsa65* only under security=reality and
  // vless* only under subprotocol=vless. A rule that fired outside those gates
  // would block a save over a value that is never sent.
  it('ML-DSA-65 is off outside REALITY', () => {
    for (const xraySecurity of ['tls', 'none']) {
      expect(pqPairErrors({ ...base, xraySecurity, xrayMldsa65Seed: SEED })).toEqual({});
    }
  });

  it('VLESS-Encryption is off outside the vless subprotocol', () => {
    for (const xraySubprotocol of ['trojan', 'vmess']) {
      expect(pqPairErrors({ ...base, xraySubprotocol, xrayVlessDecryption: DECRYPTION })).toEqual(
        {},
      );
    }
  });

  it('neither pair applies to a non-xray protocol', () => {
    // The fields are shared form state: an admin who filled them for an xray
    // profile and then switched the select to hysteria still carries the
    // values, and none of them reach the wire.
    expect(
      pqPairErrors({
        ...base,
        protocol: 'hysteria',
        xrayMldsa65Seed: SEED,
        xrayVlessEncryption: ENCRYPTION,
      }),
    ).toEqual({});
  });

  it('the two gates are independent: reality+trojan still guards the REALITY pair', () => {
    expect(
      pqPairErrors({ ...base, xraySubprotocol: 'trojan', xrayMldsa65Seed: SEED }),
    ).toEqual({ xrayMldsa65Verify: 'profiles.form.cfg.pqNeedsVerify' });
    expect(
      pqPairErrors({ ...base, xraySecurity: 'tls', xrayVlessDecryption: DECRYPTION }),
    ).toEqual({ xrayVlessEncryption: 'profiles.form.cfg.pqNeedsEncryption' });
  });
});

describe('the rules stay wired to real translations', () => {
  /** Every key the module can emit, discovered by driving it rather than by
   *  listing keys a reader would have to keep in sync. */
  const emitted = new Set<string>();
  for (const field of PQ_FIELDS) {
    for (const other of PQ_FIELDS) {
      if (other === field) continue;
      const key = pqPairError(field, { ...base, [other]: 'x' } as PqFormValues);
      if (key) emitted.add(key);
    }
  }

  it('every field carries a rule (a silent field is an unguarded half-pair)', () => {
    expect(emitted.size).toBe(PQ_FIELDS.length);
  });

  // The form now calls `t(key)` with a computed key, so the locale scan in
  // i18n/locales.test.ts - which only sees literal t('...') - no longer covers
  // these four. i18next answers a missing key with the key itself, so without
  // this the operator would read `profiles.form.cfg.pqNeedsSeed` off the form.
  it('resolves in both locales', () => {
    const lookup = (bundle: unknown, key: string): unknown =>
      key.split('.').reduce<unknown>(
        (o, part) =>
          o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[part] : undefined,
        bundle,
      );
    for (const key of emitted) {
      expect(typeof lookup(en, key), `en: ${key}`).toBe('string');
      expect(typeof lookup(ru, key), `ru: ${key}`).toBe('string');
    }
  });
});

describe('the exhaustive truth table', () => {
  // Sixteen fill states across both pairs, asserted as a whole. Written out so
  // a change to a rule shows up as a diff of behaviour rather than as one
  // renamed test, and so the four rules are proven to be independent of each
  // other rather than only tested one at a time.
  const bit = (n: number, i: number) => (n >> i) & 1;
  it('16 states, each field blamed exactly when its partner is filled and it is not', () => {
    const table: string[] = [];
    for (let n = 0; n < 16; n++) {
      const v: PqFormValues = {
        ...base,
        xrayMldsa65Seed: bit(n, 0) ? SEED : '',
        xrayMldsa65Verify: bit(n, 1) ? VERIFY : '',
        xrayVlessDecryption: bit(n, 2) ? DECRYPTION : '',
        xrayVlessEncryption: bit(n, 3) ? ENCRYPTION : '',
      };
      const blamed = (Object.keys(pqPairErrors(v)) as PqField[]).sort().join(',');
      table.push(`${n.toString(2).padStart(4, '0')} -> ${blamed || '(ok)'}`);
    }
    expect(table).toEqual([
      '0000 -> (ok)',
      '0001 -> xrayMldsa65Verify',
      '0010 -> xrayMldsa65Seed',
      '0011 -> (ok)',
      '0100 -> xrayVlessEncryption',
      '0101 -> xrayMldsa65Verify,xrayVlessEncryption',
      '0110 -> xrayMldsa65Seed,xrayVlessEncryption',
      '0111 -> xrayVlessEncryption',
      '1000 -> xrayVlessDecryption',
      '1001 -> xrayMldsa65Verify,xrayVlessDecryption',
      '1010 -> xrayMldsa65Seed,xrayVlessDecryption',
      '1011 -> xrayVlessDecryption',
      '1100 -> (ok)',
      '1101 -> xrayMldsa65Verify',
      '1110 -> xrayMldsa65Seed',
      '1111 -> (ok)',
    ]);
  });
});
