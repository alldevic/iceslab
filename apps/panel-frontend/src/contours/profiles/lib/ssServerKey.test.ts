import { describe, expect, it } from 'vitest';
import {
  newSsKey,
  ssConfigPatch,
  ssKeyBytes,
  ssKeyFits,
  ssKeyState,
  storedSsKey,
} from '@/contours/profiles/lib/ssServerKey';

const KEY16 = btoa('a'.repeat(16));
const KEY32 = btoa('b'.repeat(32));
const fresh = () => 'FRESH';

describe('ssKeyBytes / ssKeyFits', () => {
  it('2022 ciphers size the key, legacy ones do not', () => {
    expect(ssKeyBytes('2022-blake3-aes-128-gcm')).toBe(16);
    expect(ssKeyBytes('2022-blake3-aes-256-gcm')).toBe(32);
    expect(ssKeyBytes('2022-blake3-chacha20-poly1305')).toBe(32);
    expect(ssKeyBytes('aes-128-gcm')).toBeNull();
  });

  it('a key fits by decoded length, a non-base64 key fits no 2022 cipher', () => {
    expect(ssKeyFits(KEY32, '2022-blake3-chacha20-poly1305')).toBe(true);
    expect(ssKeyFits(KEY32, '2022-blake3-aes-128-gcm')).toBe(false);
    expect(ssKeyFits('not base64!', '2022-blake3-aes-256-gcm')).toBe(false);
    expect(ssKeyFits(KEY16, 'chacha20-ietf-poly1305')).toBe(true);
  });
});

describe('storedSsKey', () => {
  it('checks its input first', () => {
    expect(storedSsKey(null)).toBeNull();
    expect(storedSsKey('x')).toBeNull();
    expect(storedSsKey({ serverPsk: 5 })).toBeNull();
    expect(storedSsKey({ serverPsk: '' })).toBeNull();
    expect(storedSsKey({ serverPsk: KEY32 })).toBe(KEY32);
  });
});

describe('ssConfigPatch', () => {
  const stored = { method: '2022-blake3-aes-256-gcm', serverPsk: KEY32 };

  it('an edit that keeps the cipher sends no config, so the key stays on the server', () => {
    expect(ssConfigPatch(stored, true, '2022-blake3-aes-256-gcm', fresh)).toEqual({});
  });

  it('a changed cipher keeps the stored key when it still fits', () => {
    expect(ssConfigPatch(stored, true, '2022-blake3-chacha20-poly1305', fresh)).toEqual({
      config: { method: '2022-blake3-chacha20-poly1305', serverPsk: KEY32 },
    });
  });

  it('a changed cipher the key does not fit sends a new key, never none', () => {
    expect(ssConfigPatch(stored, true, '2022-blake3-aes-128-gcm', fresh)).toEqual({
      config: { method: '2022-blake3-aes-128-gcm', serverPsk: 'FRESH' },
    });
  });

  it('a profile the old save left keyless gets a key on its next save', () => {
    expect(ssConfigPatch({ method: '2022-blake3-aes-256-gcm' }, true, '2022-blake3-aes-256-gcm', fresh)).toEqual({
      config: { method: '2022-blake3-aes-256-gcm', serverPsk: 'FRESH' },
    });
  });

  it('a create sends the cipher alone, the server issues the key', () => {
    expect(ssConfigPatch(null, false, '2022-blake3-aes-256-gcm', fresh)).toEqual({
      config: { method: '2022-blake3-aes-256-gcm' },
    });
  });
});

describe('ssKeyState', () => {
  const stored = { method: '2022-blake3-aes-256-gcm', serverPsk: KEY32 };

  it('says set, new or server, in step with what the save sends', () => {
    expect(ssKeyState(stored, true, '2022-blake3-aes-256-gcm')).toBe('set');
    expect(ssKeyState(stored, true, '2022-blake3-aes-128-gcm')).toBe('new');
    expect(ssKeyState({ method: 'x' }, true, '2022-blake3-aes-256-gcm')).toBe('new');
    expect(ssKeyState(null, false, '2022-blake3-aes-256-gcm')).toBe('server');
  });
});

describe('newSsKey', () => {
  it('draws as many bytes as the cipher wants', () => {
    const seen: number[] = [];
    const random = (n: number) => {
      seen.push(n);
      return new Uint8Array(n);
    };
    expect(atob(newSsKey('2022-blake3-aes-128-gcm', random))).toHaveLength(16);
    expect(atob(newSsKey('aes-256-gcm', random))).toHaveLength(32);
    expect(seen).toEqual([16, 32]);
  });
});
