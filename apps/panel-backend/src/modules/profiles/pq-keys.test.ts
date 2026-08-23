import { describe, expect, it } from 'vitest';
import { parsePqKeyOutput } from './pq-keys.js';

/**
 * The parser's job is to save a copy-paste, not to be the only way through. Its
 * inputs are another project's CLI output, whose wording has already changed
 * between xray releases, so every case here also asserts that the raw output
 * survives: a field it cannot place must leave the operator exactly where they
 * were, not worse.
 */
describe('parsePqKeyOutput: mldsa65', () => {
  it('takes the seed and the verify key', () => {
    const raw = 'Seed: c2VlZHZhbHVl\nVerify: dmVyaWZ5a2V5\n';
    expect(parsePqKeyOutput('mldsa65', raw)).toEqual({
      raw,
      seed: 'c2VlZHZhbHVl',
      verify: 'dmVyaWZ5a2V5',
    });
  });

  it('reads a labelled variant the same way', () => {
    const raw = 'ML-DSA-65 Seed: AAAA\nML-DSA-65 Verify: BBBB';
    const got = parsePqKeyOutput('mldsa65', raw);
    expect(got.seed).toBe('AAAA');
    expect(got.verify).toBe('BBBB');
  });

  it('hands back the output when it recognises nothing in it', () => {
    const raw = 'unexpected output from a future build';
    expect(parsePqKeyOutput('mldsa65', raw)).toEqual({ raw });
  });
});

describe('parsePqKeyOutput: vlessenc', () => {
  // Which half is which is the whole point: the server string goes in the
  // profile and the client string in the share link, and swapping them yields a
  // profile nobody can connect to.
  it('tells the server half from the client half by its label', () => {
    const raw = [
      'Authentication: ML-KEM-768',
      'Server: mlkem768x25519plus.native.600s.SERVERSTRING',
      'Client: mlkem768x25519plus.native.0rtt.CLIENTSTRING',
    ].join('\n');
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBe('mlkem768x25519plus.native.600s.SERVERSTRING');
    expect(got.encryption).toBe('mlkem768x25519plus.native.0rtt.CLIENTSTRING');
  });

  it('accepts decryption/encryption wording too', () => {
    const raw = [
      'Decryption: mlkem768x25519plus.native.600s.AAA',
      'Encryption: mlkem768x25519plus.native.0rtt.BBB',
    ].join('\n');
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBe('mlkem768x25519plus.native.600s.AAA');
    expect(got.encryption).toBe('mlkem768x25519plus.native.0rtt.BBB');
  });

  it('takes a lone unlabelled string as the server half', () => {
    const raw = 'mlkem768x25519plus.native.600s.ONLYONE';
    expect(parsePqKeyOutput('vlessenc', raw).decryption).toBe(
      'mlkem768x25519plus.native.600s.ONLYONE',
    );
  });

  // Two strings and no labels used to be a coin flip, and putting the client's
  // string in the profile breaks every connection to it. It is not a coin flip:
  // xray tells the halves apart by the third dot-part, a handshake mode on the
  // client half and a ticket lifetime on the server half, and so do we.
  it('tells two unlabelled strings apart by their grammar', () => {
    const raw = 'mlkem768x25519plus.native.600s.AAA\nmlkem768x25519plus.native.0rtt.BBB';
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBe('mlkem768x25519plus.native.600s.AAA');
    expect(got.encryption).toBe('mlkem768x25519plus.native.0rtt.BBB');
  });

  // The grammar is what xray acts on; the label is another project's prose and
  // has already changed once. When they disagree, following the label is how a
  // profile ends up holding the client's string under a "Server:" heading.
  it('follows the grammar when a label contradicts it', () => {
    const raw = [
      'Server: mlkem768x25519plus.native.0rtt.CLIENT',
      'Client: mlkem768x25519plus.native.600s.SERVER',
    ].join('\n');
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBe('mlkem768x25519plus.native.600s.SERVER');
    expect(got.encryption).toBe('mlkem768x25519plus.native.0rtt.CLIENT');
  });

  // A build whose grammar we do not recognise is where guessing would start, so
  // it stops there: everything stays in `raw` for the operator to place.
  it('places nothing when two strings match no grammar it knows', () => {
    const raw = 'mlkem768x25519plus.native.futuremode.AAA\nmlkem768x25519plus.native.futuremode.BBB';
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBeUndefined();
    expect(got.encryption).toBeUndefined();
    expect(got.raw).toBe(raw);
  });
});

/**
 * The output `xray vlessenc` actually prints (main/commands/all/vlessenc.go):
 * four strings, not two, quoted, and two complete pairs - one authenticated
 * with X25519 and one with ML-KEM-768, under a header telling the operator not
 * to mix them. Every fixture above was hand-written prose; this one is the
 * shape the button meets on a real node.
 *
 * Verified against the binary, not just the source: xray 26.3.27 (the version
 * s1 runs), 2026-08-24. Its output is these nine lines, with the key bodies
 * 43 / 43 / 86 / 1579 chars - the lengths below reproduce them exactly. The
 * pre-fix parser given this same output returned the X25519 half with the
 * closing quote attached, which the config schema then refused.
 */
describe('parsePqKeyOutput: vlessenc, real xray output', () => {
  // Key sizes are what tells the two pairs apart, and they come from xray's own
  // parser: 32 bytes for X25519, 64 for the ML-KEM-768 server seed, 1184 for
  // the client encapsulation key.
  const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64url');
  const X25519_DEC = `mlkem768x25519plus.native.600s.${b64(32)}`;
  const X25519_ENC = `mlkem768x25519plus.native.0rtt.${b64(32)}`;
  const PQ_DEC = `mlkem768x25519plus.native.600s.${b64(64)}`;
  const PQ_ENC = `mlkem768x25519plus.native.0rtt.${b64(1184)}`;
  const raw = [
    'Choose one Authentication to use, do not mix them. Ephemeral key exchange is Post-Quantum safe anyway.',
    '',
    'Authentication: X25519, not Post-Quantum',
    `"decryption": "${X25519_DEC}"`,
    `"encryption": "${X25519_ENC}"`,
    '',
    'Authentication: ML-KEM-768, Post-Quantum',
    `"decryption": "${PQ_DEC}"`,
    `"encryption": "${PQ_ENC}"`,
  ].join('\n');

  // The field is labelled ML-KEM-768 and the whole track is post-quantum, so
  // handing over the classical pair would be the profile quietly not being what
  // it says it is.
  it('fills in the post-quantum pair, not the X25519 one printed first', () => {
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBe(PQ_DEC);
    expect(got.encryption).toBe(PQ_ENC);
  });

  // A \S+ match runs to the next whitespace and takes the closing quote with
  // it, and the config schema then rejects the value the button just typed in.
  it('stops at the closing quote the real output puts around each value', () => {
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).not.toContain('"');
    expect(got.encryption).not.toContain('"');
    expect(got.decryption).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(got.encryption).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('falls back to the classical pair, whole, when that is all there is', () => {
    const classicOnly = [
      'Authentication: X25519, not Post-Quantum',
      `"decryption": "${X25519_DEC}"`,
      `"encryption": "${X25519_ENC}"`,
    ].join('\n');
    const got = parsePqKeyOutput('vlessenc', classicOnly);
    expect(got.decryption).toBe(X25519_DEC);
    expect(got.encryption).toBe(X25519_ENC);
  });

  // Halves from different pairs are both well-formed and cannot talk to each
  // other, so the pair is picked as a pair.
  it('never mixes a server half from one pair with a client half from the other', () => {
    const got = parsePqKeyOutput('vlessenc', raw);
    expect([got.decryption, got.encryption]).toEqual([PQ_DEC, PQ_ENC]);
  });
});

/**
 * The output `xray mldsa65` actually prints: `Seed: <43 chars>` and
 * `Verify: <2603 chars>`, both base64.RawURLEncoding of a 32-byte seed and a
 * 1952-byte public key. Confirmed on xray 26.3.27, 2026-08-24.
 */
describe('parsePqKeyOutput: mldsa65, real xray output', () => {
  it('takes both halves out of the real two-line output', () => {
    const seed = Buffer.alloc(32, 2).toString('base64url');
    const verify = Buffer.alloc(1952, 3).toString('base64url');
    const got = parsePqKeyOutput('mldsa65', `Seed: ${seed}\nVerify: ${verify}\n`);
    expect(got.seed).toBe(seed);
    expect(got.verify).toBe(verify);
  });
});

