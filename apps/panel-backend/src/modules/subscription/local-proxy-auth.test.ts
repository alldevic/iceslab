import { describe, expect, it } from 'vitest';

import { localProxyCredentials } from './local-proxy-auth.js';

// The value of these credentials rests on three properties, and each is
// cheap to lose in a refactor: stable for one subscriber (a changing password
// silently breaks a config the buyer already imported), different between
// subscribers (one leak must not open everyone's tunnel), and not a
// re-encoding of the token itself (the config travels; the token should not be
// derivable from it any more easily than it already is).
describe('local proxy credentials (3.15)', () => {
  it('are stable for the same token', () => {
    expect(localProxyCredentials('tok-a')).toEqual(localProxyCredentials('tok-a'));
  });

  it('differ between subscribers', () => {
    const a = localProxyCredentials('tok-a');
    const b = localProxyCredentials('tok-b');
    expect(a.user).not.toBe(b.user);
    expect(a.pass).not.toBe(b.pass);
  });

  it('username is not a prefix of the password', () => {
    // Two hashes, not one split in half: the username travels in the clear in
    // the config and in client logs.
    const { user, pass } = localProxyCredentials('tok-a');
    expect(pass.startsWith(user)).toBe(false);
  });

  it('do not contain the token', () => {
    const token = 'fhJmpe1tRusvUdkRDByAQ4tGM2Itw';
    const { user, pass } = localProxyCredentials(token);
    expect(user).not.toContain(token);
    expect(pass).not.toContain(token);
  });

  it('are long enough to be worth requiring', () => {
    // A short password turns the whole measure into theatre: a neighbouring app
    // can hammer a loopback port as fast as the CPU allows.
    const { user, pass } = localProxyCredentials('tok-a');
    expect(user).toHaveLength(12);
    expect(pass).toHaveLength(24);
    expect(pass).toMatch(/^[0-9a-f]{24}$/);
  });
});
