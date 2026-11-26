import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mtprotoSecret, mtprotoFakeTlsSecret } from './uri.js';
import { deriveMtprotoSecret } from '../../lib/auth/credentials.js';

/**
 * The MTProto secret is the one credential in this system that two independent
 * implementations have to arrive at without talking to each other: the panel
 * puts it in the user's `tg://` link, and the node writes its raw half into
 * mtprotoproxy's USERS, from which mtprotoproxy rebuilds the same FakeTLS
 * string (`"ee" + secret + TLS_DOMAIN.hex()`).
 *
 * If the two disagree the failure is silent and total: the link imports, the
 * client shows the proxy dialog, and every connection is rejected. So the
 * agreement is pinned rather than assumed.
 */

const UUID = '2ba1b628-d1d6-4b3f-9592-00ac6bce71c1';
const OTHER_UUID = '00000000-0000-0000-0000-000000000000';
const DOMAIN = 'www.cloudflare.com';
const DOMAIN_HEX = Buffer.from(DOMAIN, 'utf8').toString('hex');

describe('the per-user MTProto secret', () => {
  it('is 32 hex chars, the 16 bytes Telegram takes, and passes the format check of the agent', () => {
    const raw = deriveMtprotoSecret(UUID);
    // A longer secret is "Invalid proxy link" in the client. The same rule the
    // agent applies in AddUser (TestAddUserRefusesAMalformedSecret).
    expect(raw).toMatch(/^[0-9a-fA-F]{32}$/);
  });

  it('is stable for a user and different between users', () => {
    expect(deriveMtprotoSecret(UUID)).toBe(deriveMtprotoSecret(UUID));
    expect(deriveMtprotoSecret(UUID)).not.toBe(deriveMtprotoSecret(OTHER_UUID));
  });

  it('does not collide with the other credentials derived from the same UUID', () => {
    const tuic = createHash('sha256').update(`${UUID}:tuic`).digest('base64url');
    expect(deriveMtprotoSecret(UUID)).not.toBe(tuic);
  });

  it('exact values for fixed inputs', () => {
    expect(deriveMtprotoSecret(UUID)).toBe('e17e0d251f90f516205983c0ed8f26ac');
    expect(deriveMtprotoSecret(OTHER_UUID)).toBe('24cc091fc27f1479a2244a9b4f85f317');
    expect(mtprotoFakeTlsSecret(deriveMtprotoSecret(UUID), DOMAIN)).toBe(
      'eee17e0d251f90f516205983c0ed8f26ac7777772e636c6f7564666c6172652e636f6d',
    );
  });

  it('is the string mtprotoproxy builds from USERS + TLS_DOMAIN', () => {
    // mtprotoproxy: `"ee" + secret + TLS_DOMAIN.encode().hex()`, run by python.
    const raw = deriveMtprotoSecret(UUID);
    const theirs = execFileSync(
      'python3',
      ['-c', 'import sys; print("ee" + sys.argv[1] + sys.argv[2].encode().hex())', raw, DOMAIN],
      { encoding: 'utf8' },
    ).trim();
    expect(mtprotoFakeTlsSecret(raw, DOMAIN)).toBe(theirs);
  });

  it('starts with the FakeTLS marker and ends with the hex domain', () => {
    const link = mtprotoFakeTlsSecret(deriveMtprotoSecret(UUID), DOMAIN);
    expect(link.startsWith('ee')).toBe(true);
    expect(link.endsWith(DOMAIN_HEX)).toBe(true);
    expect(link).toMatch(/^[0-9a-f]+$/);
  });
});

describe('the two engines do not share a secret', () => {
  it('mtg is per inbound and mtprotoproxy per user, in the same wire format', () => {
    const inboundId = 'e1b0f2a4-0000-0000-0000-00000000abcd';
    const shared = mtprotoSecret(inboundId, DOMAIN);
    const mine = mtprotoFakeTlsSecret(deriveMtprotoSecret(UUID), DOMAIN);
    expect(shared).not.toBe(mine);
    for (const s of [shared, mine]) {
      expect(s).toMatch(/^ee[0-9a-f]{32}[0-9a-f]+$/);
      expect(s.endsWith(DOMAIN_HEX)).toBe(true);
    }
  });

  it('mtprotoSecret through the shared wrapper stays what it was', () => {
    const inboundId = 'e1b0f2a4-0000-0000-0000-00000000abcd';
    const seed = createHash('sha256').update(`${inboundId}:${DOMAIN}`, 'utf8').digest().subarray(0, 16).toString('hex');
    expect(mtprotoSecret(inboundId, DOMAIN)).toBe(`ee${seed}${DOMAIN_HEX}`);
  });
});
