/**
 * The shadowsocks server key (`serverPsk`) on the profile form (A-028).
 *
 * The form has no field for the key, and every edit used to send
 * `config: { method }` as the whole config. The server stores what it is
 * given, so renaming a profile erased the key the node runs with, and the next
 * push was refused ("serverPsk is required"). The rule here is the one the
 * rest of the panel keeps: an absent key is no edit.
 */

/**
 * Bytes a 2022 cipher wants in its server key; null for a legacy AEAD cipher,
 * which carries a key the node needs but does not size it. Mirrors
 * `generateSsServerPsk` (panel-backend `profiles/ss-helpers.ts:10`).
 */
export function ssKeyBytes(method: string): number | null {
  if (!method.startsWith('2022-')) return null;
  return method === '2022-blake3-aes-128-gcm' ? 16 : 32;
}

/** The stored key, read from the config the server sent. Input checked first. */
export function storedSsKey(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const key = (config as { serverPsk?: unknown }).serverPsk;
  return typeof key === 'string' && key !== '' ? key : null;
}

/** The stored cipher, the same way. */
export function storedSsMethod(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const m = (config as { method?: unknown }).method;
  return typeof m === 'string' && m !== '' ? m : null;
}

/** Decoded length of a base64 key, or null if it is not base64 at all. */
function base64Bytes(key: string): number | null {
  try {
    return atob(key).length;
  } catch {
    return null;
  }
}

/** Whether a key can serve a cipher as it stands. */
export function ssKeyFits(key: string, method: string): boolean {
  const need = ssKeyBytes(method);
  return need === null || base64Bytes(key) === need;
}

/** A fresh key for a cipher, from the browser's CSPRNG. */
export function newSsKey(method: string, random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(ssKeyBytes(method) ?? 32);
  return btoa(String.fromCharCode(...bytes));
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * What the form says about the key.
 *
 *   set     there is a stored key and it serves the chosen cipher;
 *   new     the cipher changed and the stored key does not fit it (or there is
 *           none): a new key goes with the save, and clients get new links;
 *   server  a profile being created: the server issues the key.
 */
export type SsKeyState = 'set' | 'new' | 'server';

export function ssKeyState(storedConfig: unknown, isEdit: boolean, method: string): SsKeyState {
  if (!isEdit) return 'server';
  const key = storedSsKey(storedConfig);
  return key !== null && ssKeyFits(key, method) ? 'set' : 'new';
}

/**
 * The config an edit sends.
 *
 * Nothing at all while the cipher is the stored one and its key fits: the key
 * and everything else in the config stay as the server has them. A profile
 * the old save already left keyless gets a new key on its next save, which is
 * what brings it back to the node. A changed cipher sends the
 * stored key with it when the key still fits (aes-256 and chacha20 both want
 * 32 bytes), and a new one when it does not, so the save never leaves the
 * profile without a key. A create sends the cipher alone, the server fills
 * the key in (`profiles.service.ts:327`).
 */
export function ssConfigPatch(
  storedConfig: unknown,
  isEdit: boolean,
  method: string,
  fresh: (method: string) => string = newSsKey,
): { config?: { method: string; serverPsk?: string } } {
  if (!isEdit) return { config: { method } };
  const key = storedSsKey(storedConfig);
  const fits = key !== null && ssKeyFits(key, method);
  if (fits && storedSsMethod(storedConfig) === method) return {};
  return { config: { method, serverPsk: fits ? key : fresh(method) } };
}
