import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mtprotoSecret, mtprotoFakeTlsSecret } from './uri.js';
import { deriveMtprotoSecret } from '../../lib/credentials.js';

/**
 * The MTProto secret is the one credential in this system that two independent
 * implementations have to arrive at without talking to each other: the panel
 * puts it in the buyer's `tg://` link, and the node writes its raw half into
 * mtprotoproxy's USERS, from which mtprotoproxy rebuilds the same FakeTLS
 * string (`"ee" + secret + TLS_DOMAIN.hex()`, mtprotoproxy.py:2189).
 *
 * If those two disagree the failure is silent and total: the link imports fine,
 * Telegram shows the proxy dialog, and every connection is rejected. So the
 * agreement is worth pinning rather than assuming.
 */

const UUID = '2ba1b628-d1d6-4b3f-9592-00ac6bce71c1';
const DOMAIN = 'www.cloudflare.com';

describe('the per-user MTProto secret', () => {
  it('is 32 hex chars — the 16 bytes Telegram mandates', () => {
    const raw = deriveMtprotoSecret(UUID);
    expect(raw).toMatch(/^[0-9a-f]{32}$/);
    // Not a style preference: a longer secret is rejected outright by the
    // Telegram client with "Invalid proxy link", caught on iOS 2026-05-13.
    expect(raw).toHaveLength(32);
  });

  it('is stable for a user and different between users', () => {
    expect(deriveMtprotoSecret(UUID)).toBe(deriveMtprotoSecret(UUID));
    expect(deriveMtprotoSecret(UUID)).not.toBe(
      deriveMtprotoSecret('00000000-0000-0000-0000-000000000000'),
    );
  });

  it('does not collide with the other credentials derived from the same UUID', () => {
    // They all hash the same input with a different tag. A copy-paste that lost
    // the tag would hand a user the same string as their TUIC password, and
    // nothing downstream would notice.
    const mt = deriveMtprotoSecret(UUID);
    const tuic = createHash('sha256').update(`${UUID}:tuic`).digest('base64url');
    expect(mt).not.toBe(tuic);
  });

  it('rebuilds exactly what mtprotoproxy builds from USERS + TLS_DOMAIN', () => {
    // mtprotoproxy.py:2189 — `tls_secret = "ee" + secret + TLS_DOMAIN.encode().hex()`.
    // This asserts our spelling of that line, against the raw secret the node
    // was given.
    const raw = deriveMtprotoSecret(UUID);
    const theirs = 'ee' + raw + Buffer.from(DOMAIN, 'utf8').toString('hex');
    expect(mtprotoFakeTlsSecret(raw, DOMAIN)).toBe(theirs);
  });

  it('starts with the FakeTLS marker and ends with the hex domain', () => {
    const link = mtprotoFakeTlsSecret(deriveMtprotoSecret(UUID), DOMAIN);
    expect(link.startsWith('ee')).toBe(true);
    expect(link.endsWith(Buffer.from(DOMAIN, 'utf8').toString('hex'))).toBe(true);
    expect(link).toMatch(/^[0-9a-f]+$/);
  });
});

describe('the two engines do not share a secret', () => {
  it('the mtg secret is per-inbound and the mtprotoproxy one per-user', () => {
    const inboundId = 'e1b0f2a4-0000-0000-0000-00000000abcd';
    const shared = mtprotoSecret(inboundId, DOMAIN);
    const mine = mtprotoFakeTlsSecret(deriveMtprotoSecret(UUID), DOMAIN);
    expect(shared).not.toBe(mine);
    // Both are still valid FakeTLS secrets over the same domain: the engines
    // differ in WHO the secret belongs to, not in the wire format.
    for (const s of [shared, mine]) {
      expect(s).toMatch(/^ee[0-9a-f]{32}[0-9a-f]+$/);
      expect(s.endsWith(Buffer.from(DOMAIN, 'utf8').toString('hex'))).toBe(true);
    }
  });

  it('mtg still gives every user of an inbound the same secret', () => {
    // Pinned because it is the limitation the second engine exists to remove;
    // if this ever stops being true, the reason for that engine changed.
    const inboundId = 'e1b0f2a4-0000-0000-0000-00000000abcd';
    expect(mtprotoSecret(inboundId, DOMAIN)).toBe(mtprotoSecret(inboundId, DOMAIN));
  });
});
