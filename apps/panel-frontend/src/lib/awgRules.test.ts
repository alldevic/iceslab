import { describe, expect, it } from 'vitest';

import { AWG_FIELDS, WG_KEY_RE, awgFieldError, type AwgFormValues } from './awgRules.js';

const OK: AwgFormValues = {
  protocol: 'amneziawg',
  awgJmin: 64,
  awgJmax: 128,
  awgS1: 32,
  awgS2: 56,
  awgH1: 100,
  awgH2: 200,
  awgH3: 300,
  awgH4: 400,
  awgServerPriv: 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQHFM=',
  awgServerPub: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
};

const with_ = (patch: Partial<AwgFormValues>): AwgFormValues => ({ ...OK, ...patch });

/** Every field, so a rule that starts returning a message for something it
 *  should ignore is caught rather than only the field under test. */
const allErrors = (v: AwgFormValues): Record<string, string | null> =>
  Object.fromEntries(AWG_FIELDS.map((f) => [f, awgFieldError(f, v)]));

describe('awgFieldError', () => {
  it('says nothing about a profile the TSPU preset would produce', () => {
    // The control for every case below: these values are the ones the form
    // seeds itself with, so if they tripped a rule the form would refuse to
    // save its own defaults.
    expect(allErrors(OK)).toEqual(
      Object.fromEntries(AWG_FIELDS.map((f) => [f, null])),
    );
  });

  it('refuses an inverted junk range, on Jmax', () => {
    const errs = allErrors(with_({ awgJmin: 512, awgJmax: 128 }));
    expect(errs.awgJmax).toBe('profiles.form.cfg.awgJminOverJmax');
    expect(errs.awgS2, 'the message landed on more than one field').toBeNull();
  });

  it('allows Jmin equal to Jmax, which the node allows', () => {
    // `<=`, not `<`. Getting this wrong refuses a config the node runs.
    expect(awgFieldError('awgJmax', with_({ awgJmin: 128, awgJmax: 128 }))).toBeNull();
  });

  it('refuses s1 + 56 === s2, the plain WireGuard handshake length', () => {
    // With the preset's S2 of 56 this is reachable with one keystroke: S1 = 0.
    const errs = allErrors(with_({ awgS1: 0, awgS2: 56 }));
    expect(errs.awgS2).toBe('profiles.form.cfg.awgS1PlusHandshake');
  });

  it('and says nothing when the sum merely comes close', () => {
    expect(awgFieldError('awgS2', with_({ awgS1: 1, awgS2: 56 }))).toBeNull();
    expect(awgFieldError('awgS2', with_({ awgS1: 0, awgS2: 57 }))).toBeNull();
  });

  it('refuses a repeated magic header, on the later of the pair', () => {
    const errs = allErrors(with_({ awgH2: 100 })); // equals H1
    expect(errs.awgH2).toBe('profiles.form.cfg.awgHDuplicate');
    expect(errs.awgH1, 'both halves of the pair were lit; there is one thing to change').toBeNull();
  });

  it('catches a duplicate at any distance, not just neighbours', () => {
    expect(awgFieldError('awgH4', with_({ awgH4: 100 }))).toBe('profiles.form.cfg.awgHDuplicate');
    expect(awgFieldError('awgH3', with_({ awgH3: 200 }))).toBe('profiles.form.cfg.awgHDuplicate');
  });

  it('refuses a key that is not one, and takes the ones wg genkey emits', () => {
    expect(awgFieldError('awgServerPriv', with_({ awgServerPriv: 'not-a-key' }))).toBe(
      'profiles.form.cfg.awgKeyShape',
    );
    // The shape that mattered enough to be whitelisted on the node: a newline
    // in a pushed key used to close [Peer] and open [Interface] with a PostUp.
    expect(
      awgFieldError('awgServerPub', with_({ awgServerPub: 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQ\nFM=' })),
    ).toBe('profiles.form.cfg.awgKeyShape');
    expect(awgFieldError('awgServerPub', OK)).toBeNull();
  });

  it('leaves an empty key to the required prop', () => {
    // "Not a valid key" about a field nobody has touched is noise, and the
    // field is already `required`.
    expect(awgFieldError('awgServerPriv', with_({ awgServerPriv: '' }))).toBeNull();
  });

  it('says nothing at all about a WireGuard profile', () => {
    // WireguardConfigSchema has no obfuscation member on purpose, so none of
    // these values exist there. Every rule must stand down.
    const wg = with_({ protocol: 'wireguard', awgJmin: 512, awgJmax: 1, awgH2: 100, awgS1: 0 });
    expect(allErrors(wg)).toEqual(Object.fromEntries(AWG_FIELDS.map((f) => [f, null])));
  });

  it('holds a blank number without deciding anything', () => {
    // Mantine hands '' while the operator is mid-edit; a rule that treated it
    // as 0 would report `s1 + 56 === s2` at every keystroke.
    expect(awgFieldError('awgS2', with_({ awgS1: '' }))).toBeNull();
    expect(awgFieldError('awgJmax', with_({ awgJmax: '' }))).toBeNull();
  });

  it('accepts exactly what a 32-byte base64 key looks like', () => {
    expect(WG_KEY_RE.test('A'.repeat(43) + '=')).toBe(true);
    expect(WG_KEY_RE.test('A'.repeat(44)), '44 chars with no padding is 33 bytes').toBe(false);
    expect(WG_KEY_RE.test('A'.repeat(42) + '=')).toBe(false);
  });
});
