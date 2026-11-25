// The per-user secrets that are DERIVED rather than stored.
//
// Three protocols (tuic, anytls, shadowtls) get their password from the user's
// xray uuid instead of a database column. That makes the derivation itself the
// credential: change it, and every existing user of those protocols is rotated
// to a key nobody handed them. `credentials.test.ts` next door covers
// `generateUserCredentials` and nothing else in this file.
//
// The shadowsocks key block (and its shared vectors) is added with the
// shadowsocks derivation fix, milestone 6.3.

import { describe, expect, it } from 'vitest';
import {
  deriveAnytlsPassword,
  deriveShadowtlsPassword,
  deriveSsPassword,
  deriveTuicPassword,
} from './credentials.js';

const UUID_A = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const UUID_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

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

  // The VALUE, not just its shape. Everything above still passes when the salt
  // changes - the result stays deterministic, distinct, url-safe and
  // uuid-dependent - and that was measured: the whole suite stayed green with
  // `deriveTuicPassword`'s salt changed.
  //
  // Rotation is not free even though both consumers are on this side. The node
  // keeps the password it was last pushed, while the subscription serves the
  // new one immediately, so between a deploy and the next inbound push every
  // client that refetches gets a credential the node does not accept. Same
  // reasoning as the shadowsocks vectors: this makes rotating them a deliberate
  // act rather than a side effect of editing a string.
  it('is the value it has always been', () => {
    expect(deriveTuicPassword(UUID_A)).toBe('f3CHWYGSxJ3LUlDQf-i6mn--7kN7zEoiCmhSo3znsgM');
    expect(deriveAnytlsPassword(UUID_A)).toBe('ZrsEClvRM-vBFEUe9ba9N1XZLdneVz2-KKAWkoQP5tg');
    expect(deriveShadowtlsPassword(UUID_A)).toBe('yz6GmlBpwFMEnyeUKR2xRwo1ZykxCdS0y2-7oqSb1rc');
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
