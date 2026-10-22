import { randomBytes } from 'node:crypto';

/**
 * Auto-generate a server PSK of the right length for the given SS2022
 * cipher. Mirrors the helper that used to live in inbounds.service.ts.
 *
 * - aes-128-gcm  → 16 bytes
 * - aes-256-gcm / chacha20-poly1305 / legacy AEAD → 32 bytes
 */
const pskBytes = (method: string): number => (method === '2022-blake3-aes-128-gcm' ? 16 : 32);

export function generateSsServerPsk(method: string): string {
  return randomBytes(pskBytes(method)).toString('base64');
}

/** A stored server PSK still usable with `method`: base64 of its key length. */
export function pskFitsMethod(psk: string, method: string): boolean {
  return Buffer.from(psk, 'base64').length === pskBytes(method);
}
