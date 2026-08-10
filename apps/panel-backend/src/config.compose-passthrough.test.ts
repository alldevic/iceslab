import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * A setting the container never receives is not a setting.
 *
 * This has now bitten three times, always the same way: the knob exists in the
 * config schema, in `.env.production.example` and in the code that reads it, but
 * the passthrough line in `docker-compose.prod.yml` is missing. The operator
 * fills it in, nothing happens, and there is nothing to debug because the
 * feature simply believes it is disabled.
 *
 *   - HONEY_USER_TOKENS: honey-token requests fell through to the normal
 *     subscription handler (found 2026-05-12, see the comment in the compose
 *     file).
 *   - WEBHOOK_URLS / WEBHOOK_SECRET: the whole outbound event bus was dead in
 *     production - not one delivery was even attempted (found 2026-08-10 while
 *     field-testing webhooks).
 *   - SUBSCRIPTION_PUBLIC_URL / SUBSCRIPTION_PATH_PREFIX: /sub could not be
 *     moved to its own domain or off its default path (found in the same pass).
 *
 * So the compose file is checked against the schema mechanically. Adding a key
 * to the schema without a passthrough now fails here rather than in someone's
 * production.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/**
 * Keys the panel declares but does NOT consume: they are read by the node agent
 * (`apps/node/main.go`) and its installer, and only linger in the panel schema
 * for historical reasons. Passing them to the panel container would be noise.
 *
 * Anything else missing from compose is a bug, not an entry for this list.
 */
const NOT_PANEL_SETTINGS = new Set([
  'XRAY_PUBLIC_PORT',
  'XRAY_REALITY_SNI',
  'XRAY_REALITY_PUBLIC_KEY',
  'XRAY_REALITY_SHORT_ID',
  'XRAY_FINGERPRINT',
  'XRAY_FLOW',
]);

function schemaKeys(): string[] {
  const src = readFileSync(resolve(repoRoot, 'apps/panel-backend/src/config.ts'), 'utf8');
  // Schema entries are `  NAME: z...` at two-space indent inside the object.
  return [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]*):\s*z/gm)].map((m) => m[1]!);
}

function composeEnvKeys(): Set<string> {
  const src = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
  return new Set([...src.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]!));
}

describe('docker-compose.prod.yml passes every panel setting through', () => {
  it('has a line for each key the config schema declares', () => {
    const declared = schemaKeys().filter((k) => !NOT_PANEL_SETTINGS.has(k));
    const passed = composeEnvKeys();
    const missing = declared.filter((k) => !passed.has(k));

    expect(
      missing,
      `These settings exist in the schema but never reach the container, so an ` +
        `operator setting them in .env.production gets silence:\n  ${missing.join('\n  ')}\n` +
        `Add a "KEY: \${KEY:-default}" line to the backend service in ` +
        `docker-compose.prod.yml, or list it in NOT_PANEL_SETTINGS if the panel ` +
        `genuinely does not consume it.`,
    ).toEqual([]);
  });

  // Guards the guard: if the extraction ever stops matching (a formatting change
  // in either file), the test above would pass vacuously with an empty list.
  it('actually finds the keys it compares', () => {
    expect(schemaKeys().length).toBeGreaterThan(20);
    expect(composeEnvKeys().size).toBeGreaterThan(20);
    expect(schemaKeys()).toContain('WEBHOOK_URLS');
    expect(composeEnvKeys()).toContain('DATABASE_URL');
  });
});
