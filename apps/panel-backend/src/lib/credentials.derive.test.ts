// The per-user secrets that are DERIVED rather than stored.
//
// Four protocols get their password from the user's xray uuid instead of a
// database column - the "don't grow the credential surface" decision. That
// makes the derivation itself the credential: change it, and every existing
// user of those protocols is rotated to a key nobody handed them.
//
// Measured before writing: the whole suite of 1611 stayed green with the salt
// of `deriveSsPassword` changed, green with the salt of `deriveTuicPassword`
// changed, and green with the SS key length forced to 32 for every cipher.
// `credentials.test.ts` next door covers `generateUserCredentials` and nothing
// else in this file.
//
// The shadowsocks half also crosses a language boundary - see the fixture note.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveAnytlsPassword,
  deriveShadowtlsPassword,
  deriveSsPassword,
  deriveTuicPassword,
} from './credentials.js';

const UUID_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const UUID_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const VECTORS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/shared/testdata/ss-password-vectors.json',
);

describe('the shadowsocks key both sides compute', () => {
  // The node writes the SS config from its own copy of this function
  // (internal/core/sscreds.go). Nothing tied the two together, and a
  // disagreement is invisible from either side: the push succeeds, the node
  // comes up healthy, and every shadowsocks user fails authentication because
  // the key in their URI is not the key on the wire.
  //
  // The fixture is the contract. The Go test reads the same file, so a change
  // on either side reddens on that side.
  it('matches the shared vectors, byte for byte', () => {
    const doc = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
      vectors: { uuid: string; method: string; key: string }[];
    };
    expect(doc.vectors.length, 'the fixture is empty or unreadable').toBeGreaterThan(5);

    for (const v of doc.vectors) {
      expect(
        deriveSsPassword(v.uuid, v.method),
        `${v.method} for ${v.uuid} no longer matches the shared vector - the node computes ` +
          'the old one, so every shadowsocks user of this panel would stop authenticating',
      ).toBe(v.key);
    }
  });

  // SS2022 keys MUST be a specific length: 16 bytes for the 128-bit cipher, 32
  // for the others. A key of the wrong length is rejected by the core outright,
  // which is the loud failure; a key of the right length but the wrong bytes is
  // the silent one.
  it('sizes the key to the cipher', () => {
    const short = Buffer.from(deriveSsPassword(UUID_A, '2022-blake3-aes-128-gcm'), 'base64');
    expect(short).toHaveLength(16);

    for (const method of ['2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'anything-else']) {
      expect(Buffer.from(deriveSsPassword(UUID_A, method), 'base64'), method).toHaveLength(32);
    }
  });

  // Standard base64, NOT base64url: SS2022 requires it, and the "helpful"
  // switch to base64url (which the other three derivations DO use) produces a
  // string the core refuses.
  it('encodes as standard base64, padding and all', () => {
    const key = deriveSsPassword(UUID_A, '2022-blake3-aes-128-gcm');
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(key.endsWith('='), 'a 16-byte value is 24 base64 characters including padding').toBe(true);
    expect(key, 'base64url would spell this key with - and _ and no padding').not.toMatch(/[-_]/);
  });

  // The 128-bit key is not simply a truncation nobody would notice: it is the
  // first half of the 256-bit one. Stated so that a future change to either
  // length is a decision rather than a surprise.
  it('derives the short key as the prefix of the long one', () => {
    const short = deriveSsPassword(UUID_A, '2022-blake3-aes-128-gcm');
    const long = deriveSsPassword(UUID_A, '2022-blake3-aes-256-gcm');
    expect(Buffer.from(long, 'base64').subarray(0, 16)).toEqual(Buffer.from(short, 'base64'));
  });
});

describe('the three passwords the panel derives for itself', () => {
  const derivations = [
    ['tuic', deriveTuicPassword],
    ['anytls', deriveAnytlsPassword],
    ['shadowtls', deriveShadowtlsPassword],
  ] as const;

  // Derived in two places on the panel side - the credentials pushed to the
  // node, and the subscription the client reads - so the same input must give
  // the same answer every time it is asked.
  it('is deterministic', () => {
    for (const [name, fn] of derivations) {
      expect(fn(UUID_A), name).toBe(fn(UUID_A));
    }
  });

  // Each protocol is salted with its own name. Without that, one password
  // leaked from a client config would be the password for all three, and a
  // subscriber's shadowtls secret would open their tuic endpoint.
  it('gives every protocol a different password for the same user', () => {
    const keys = derivations.map(([, fn]) => fn(UUID_A));
    expect(new Set(keys).size, 'two protocols share a password').toBe(keys.length);
    // And none of them equals the shadowsocks key either.
    expect(keys).not.toContain(deriveSsPassword(UUID_A, '2022-blake3-aes-256-gcm'));
  });

  it('gives every user a different password for the same protocol', () => {
    for (const [name, fn] of derivations) {
      expect(fn(UUID_A), name).not.toBe(fn(UUID_B));
    }
  });

  // These go into subscription URIs, so the alphabet matters: a `+` or a `/`
  // would have to be percent-encoded, and a client that forgets to decode
  // authenticates with the wrong string.
  it('is url-safe base64 of the full digest', () => {
    for (const [name, fn] of derivations) {
      const key = fn(UUID_A);
      expect(key, name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(key, 'base64url'), name).toHaveLength(32);
    }
  });

  // The uuid is the only input. A derivation that silently ignored it would
  // hand every user on the panel the same password - and would still look
  // deterministic and url-safe in every check above.
  it('actually reads the uuid', () => {
    for (const [name, fn] of derivations) {
      const keys = new Set([UUID_A, UUID_B, '00000000-0000-4000-8000-000000000001'].map(fn));
      expect(keys.size, `${name} returns the same password for different users`).toBe(3);
    }
  });
});
