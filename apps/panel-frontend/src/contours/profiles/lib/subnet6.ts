/**
 * The IPv6 subnet of a WireGuard-family tunnel (milestone 18.9): a ULA /64,
 * `fdXX:XXXX:XXXX:XXXX::/64`, optional. Held to the backend's pattern
 * (SUBNET6_PATTERN, amneziawg.subnet.ts) by profileRules.mirror.test.ts. A
 * peer's address in it is derived from its IPv4 one by the server, so the
 * operator only picks the prefix; the button draws a random one (RFC 4193).
 */
export const SUBNET6_RE = /^f[cd][0-9a-f]{2}(:[0-9a-f]{1,4}){3}::\/64$/i;

/** The field is wrong: filled, and not a ULA /64. Empty is fine (IPv4 only). */
export function subnet6Problem(value: string): boolean {
  const v = value.trim();
  return v !== '' && !SUBNET6_RE.test(v);
}

/**
 * Saving a changed IPv6 subnet on a saved profile makes the agent bring the
 * interface up again (milestone 18.10): every device on the profile reconnects.
 * A new profile has nothing to drop. A subnet that is not valid yet is not a
 * change that can be saved.
 */
export function subnet6ChangeRestarts(isEdit: boolean, saved: string, value: string): boolean {
  return isEdit && !subnet6Problem(value) && saved.trim() !== value.trim();
}

/** A random ULA /64: `fd`, a 40-bit global id, a 16-bit subnet id. */
export function randomSubnet6(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(7);
  const group = (i: number) => (((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16);
  return `fd${(b[0] ?? 0).toString(16).padStart(2, '0')}:${group(1)}:${group(3)}:${group(5)}::/64`;
}
