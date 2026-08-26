// The contract between the installer and this config schema.
//
// `scripts/install-iceslab.sh` writes `.env.production` from a heredoc and then
// brings the stack up. If the backend gains a REQUIRED environment variable and
// that heredoc is not updated with it, the schema below refuses to parse, the
// backend exits on boot, and the only way to find out is to install a panel.
// Every existing operator is fine - their env file already has what they need -
// so it breaks for new installs only, which is the slowest possible feedback.
//
// The installer is deliberately standalone (curl-piped, sources nothing), so it
// cannot be imported and called; the heredoc is read out of the script instead.
// Same instrument as the panel↔node wire test and the webhook registry: the
// source of truth is read, not copied.
//
// Measured when this was written: the template covers all four required keys.
// The test exists so that stays true.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, '../../../scripts/install-iceslab.sh');
const CONFIG = resolve(HERE, 'config.ts');

function installerSource(): string {
  return readFileSync(INSTALLER, 'utf8');
}

/** The keys the generated .env.production will contain. */
function templateKeys(): Set<string> {
  const src = installerSource();
  const start = src.indexOf('cat > "$ENV_FILE" <<EOF');
  expect(start, 'the .env.production heredoc was renamed or moved').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\nEOF', start));
  return new Set([...body.matchAll(/^([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!));
}

/**
 * Keys of the schema that have neither a default nor an optional marker, i.e.
 * the ones whose absence stops the process from booting.
 */
function requiredConfigKeys(): string[] {
  const src = readFileSync(CONFIG, 'utf8');
  const body = src.slice(src.indexOf('z.object({'));
  const out: string[] = [];
  const re = /^ {2}([A-Z][A-Z0-9_]{3,}):\s*([\s\S]*?)(?=^ {2}[A-Z][A-Z0-9_]{3,}:|^\}\);)/gm;
  for (const m of body.matchAll(re)) {
    const decl = m[2]!;
    if (!decl.includes('.default(') && !decl.includes('.optional()') && !decl.includes('.nullish()')) {
      out.push(m[1]!);
    }
  }
  return out;
}

describe('the installer writes an env file this schema accepts', () => {
  // Control: both parsers have to actually find something, or the comparison
  // below passes by reading nothing.
  it('reads both sides', () => {
    expect(templateKeys().size).toBeGreaterThan(15);
    const required = requiredConfigKeys();
    expect(required.length).toBeGreaterThan(2);
    expect(required, 'the four the panel cannot boot without').toContain('DATABASE_URL');
    expect(required).toContain('JWT_SECRET');
  });

  it('sets every variable the panel cannot start without', () => {
    const keys = templateKeys();
    for (const key of requiredConfigKeys()) {
      expect(
        keys.has(key),
        `${key} is required by config.ts and install-iceslab.sh never writes it: a fresh ` +
          'install would come up to a backend that exits on boot, while every existing ' +
          'deployment stays fine',
      ).toBe(true);
    }
  });

  // The two secrets are minted by the installer rather than typed by an
  // operator, so their strength is the installer's responsibility. JWT_SECRET
  // has a hard floor in the schema; a shorter one fails validation at boot.
  it('mints secrets that satisfy the schema', () => {
    const src = installerSource();
    // `openssl rand -hex N` yields 2N characters.
    const jwt = src.match(/JWT_SECRET=\$\(openssl rand -hex (\d+)\)/);
    expect(jwt, 'JWT_SECRET is no longer generated with openssl rand -hex').not.toBeNull();
    expect(Number(jwt![1]) * 2, 'the schema requires at least 32 characters').toBeGreaterThanOrEqual(32);

    const pg = src.match(/PG_PASSWORD=\$\(openssl rand -hex (\d+)\)/);
    expect(pg, 'the Postgres password is no longer generated').not.toBeNull();
    expect(Number(pg![1]) * 2).toBeGreaterThanOrEqual(24);
  });

  // The file holds the JWT secret, the database password and, after a
  // bootstrap, the node CA material reachable through them.
  it('locks the env file down', () => {
    expect(installerSource()).toContain('chmod 600 "$ENV_FILE"');
  });

  // Re-running the installer must not mint new secrets over a live deployment:
  // a fresh JWT_SECRET signs out every admin, and a fresh Postgres password
  // locks the backend out of its own database.
  it('keeps the secrets of an existing installation', () => {
    const src = installerSource();
    const guard = src.indexOf('if [[ -f "$ENV_FILE" ]]');
    const write = src.indexOf('cat > "$ENV_FILE" <<EOF');
    expect(guard, 'the "already exists" guard is gone').toBeGreaterThan(-1);
    expect(guard, 'the guard must come before the write').toBeLessThan(write);
    expect(src).toContain('already exists, keeping current secrets');
  });

  // The installer waits for the stack by grepping /health for this exact
  // string. app.health.test.ts pins the endpoint's side of it; this pins the
  // installer's.
  it('waits for the health body the endpoint actually emits', () => {
    expect(installerSource()).toContain(`'"status":"ok"'`);
  });
});
