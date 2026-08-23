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

  // Two strings and no labels: either could be either, and putting the client's
  // string in the profile breaks every connection to it.
  it('refuses to guess between two unlabelled strings', () => {
    const raw = 'mlkem768x25519plus.native.600s.AAA\nmlkem768x25519plus.native.0rtt.BBB';
    const got = parsePqKeyOutput('vlessenc', raw);
    expect(got.decryption).toBeUndefined();
    expect(got.encryption).toBeUndefined();
    expect(got.raw).toBe(raw);
  });
});
