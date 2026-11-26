/**
 * Scanner paths the security gate answers with a fake 404 and a blacklist entry.
 * Kept apart from security-gate.ts (which imports the config) so the config can
 * read the prefix list without a cycle: SUBSCRIPTION_PATH_PREFIX must not sit
 * under a trap, or every subscriber is trapped and blacklisted.
 */
export const HONEYPOT_EXACT: ReadonlySet<string> = new Set<string>([
  '/.env',
  '/.git/config',
  '/.aws/credentials',
  '/wp-config.php',
  '/xmlrpc.php',
  '/phpinfo.php',
  '/server-status',
]);
export const HONEYPOT_PREFIXES: readonly string[] = [
  '/wp-admin',
  '/wp-login',
  '/wordpress',
  '/phpmyadmin',
  '/.git/',
];

/**
 * The trap prefix a subscription prefix would fall under, or null. The gate
 * matches case-insensitively and by startsWith, so `/WordPress` and `/wordpress2`
 * collide as well as `/wordpress`.
 */
export function collidingHoneypotPrefix(subscriptionPrefix: string): string | null {
  const lower = subscriptionPrefix.toLowerCase();
  return HONEYPOT_PREFIXES.find((p) => lower.startsWith(p)) ?? null;
}
