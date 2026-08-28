import { randomBytes } from 'node:crypto';

/**
 * Key length an SS2022 cipher demands of its PSK, in bytes.
 *
 * - aes-128-gcm  → 16 bytes
 * - aes-256-gcm / chacha20-poly1305 / legacy AEAD → 32 bytes
 *
 * Legacy AEAD ciphers take an arbitrary password, so the number is only a
 * generation size for them; for the `2022-blake3-*` family it is a hard
 * requirement both cores enforce.
 */
export function ssKeyLengthFor(method: string): number {
  return method === '2022-blake3-aes-128-gcm' ? 16 : 32;
}

/**
 * Auto-generate a server PSK of the right length for the given SS2022
 * cipher. Mirrors the helper that used to live in inbounds.service.ts.
 */
export function generateSsServerPsk(method: string): string {
  return randomBytes(ssKeyLengthFor(method)).toString('base64');
}
