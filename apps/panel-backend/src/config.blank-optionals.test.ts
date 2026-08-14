import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ConfigSchema } from './config.js';

/**
 * An operator who leaves a setting blank must not be able to stop the panel from
 * booting.
 *
 * docker-compose writes `KEY: ${KEY:-}` for every optional setting, so a blank
 * one arrives as an EMPTY STRING, not as an absent variable. Zod's `.url()`,
 * `.email()` and friends reject `""` as malformed rather than reading it as
 * "not set", and the panel exits on invalid config - so one blank line in
 * `.env.production` becomes a crash-loop.
 *
 * The codebase already knew this: PANEL_PUBLIC_IP, ACME_DEFAULT_EMAIL and the
 * TELEGRAM_* settings all coerce `""` to undefined, with a comment explaining
 * why. SUBSCRIPTION_PUBLIC_URL was the one that missed the convention, and it
 * stayed harmless only because nothing passed it into the container. Adding the
 * passthrough turned it into a downed panel on 2026-08-10.
 *
 * This test feeds the schema exactly what compose would: required settings with
 * real values, every optional one blank.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/** The settings compose passes with `${KEY:-}`, i.e. blank when unset. */
function blankableComposeKeys(): string[] {
  const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
  return [...compose.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*\$\{[A-Z0-9_]+:-\}\s*$/gm)].map(
    (m) => m[1]!,
  );
}

// What the panel genuinely cannot start without, with values shaped like the
// real ones.
const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@postgres:5432/iceslab',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://panel.example.com',
};

describe('a blank optional setting does not stop the panel booting', () => {
  it('parses an environment where every blankable setting is an empty string', () => {
    const blanks = Object.fromEntries(blankableComposeKeys().map((k) => [k, '']));
    const result = ConfigSchema.safeParse({ ...REQUIRED, ...blanks });

    const failed = result.success
      ? []
      : Object.keys(result.error.flatten().fieldErrors ?? {});
    expect(
      failed,
      `These settings reject an empty string, so leaving them blank in ` +
        `.env.production crash-loops the panel:\n  ${failed.join('\n  ')}\n` +
        `Read "" as unset, the way PANEL_PUBLIC_IP and ACME_DEFAULT_EMAIL do.`,
    ).toEqual([]);
  });

  // The specific one that took production down, pinned by name so a future
  // rewrite of the field cannot quietly reintroduce it.
  it('reads a blank SUBSCRIPTION_PUBLIC_URL as "no separate domain"', () => {
    const parsed = ConfigSchema.parse({ ...REQUIRED, SUBSCRIPTION_PUBLIC_URL: '' });
    expect(parsed.SUBSCRIPTION_PUBLIC_URL).toBeUndefined();
  });

  it('still rejects a SUBSCRIPTION_PUBLIC_URL that is set but malformed', () => {
    const bad = ConfigSchema.safeParse({ ...REQUIRED, SUBSCRIPTION_PUBLIC_URL: 'not-a-url' });
    expect(bad.success).toBe(false);
  });

  // Guards the guard: if the compose pattern stops matching, the first test
  // would pass while checking nothing.
  it('finds the blankable keys it is supposed to check', () => {
    expect(blankableComposeKeys().length).toBeGreaterThan(3);
  });
});
