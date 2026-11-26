// The contract between the installer and this config schema.
//
// `scripts/install-iceslab.sh` writes `.env.production` from a heredoc and then
// brings the stack up. If the backend gains a REQUIRED environment variable and
// that heredoc is not updated with it, the schema refuses to parse, the backend
// exits on boot, and the only way to find out is to install a panel. Every
// existing operator is fine - their env file already has what they need - so it
// breaks for new installs only, which is the slowest possible feedback.
//
// The installer is deliberately standalone (curl-piped, sources nothing), so it
// cannot be imported and called; the heredoc and the ACME expression are read
// out of the script instead: the source of truth is read, not copied.
//
// HOW TO EXTEND: a milestone that changes the installer's env template, its
// secrets or its ACME prompt adds its case here, in the same merge.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
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
    expect(required, 'the keys the panel cannot boot without').toContain('DATABASE_URL');
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

  // The installer waits for the stack by looking for this string in /health.
  // app.health.test.ts pins the endpoint's side of it; this pins the
  // installer's. The meaning is what is asserted (the body is searched for the
  // ok status), not the exact probe line, which gets timeouts and wrappers.
  it('waits for the health body the endpoint actually emits', () => {
    const src = installerSource();
    expect(src).toContain(`'"status":"ok"'`);
    expect(src, 'the loop no longer probes /health').toMatch(/http:\/\/127\.0\.0\.1:3000\/health/);
  });
});

/**
 * The ACME email, validated twice.
 *
 * `install-iceslab.sh` asks for it at a prompt (or takes it from the
 * environment) and checks it with an ERE (`ACME_EMAIL_RE`, `grep -E` under
 * LC_ALL=C, from a here-string); the panel checks the same value with
 * `z.email()` when it boots. The two are one decision written in two languages.
 * On 2026-08-10 an operator typed one Cyrillic letter, the installer took it,
 * and the panel refused to boot on it eleven minutes later, at step 9 of 9,
 * reported as "container is unhealthy".
 *
 * The rule is one-directional. Anything the installer accepts the panel MUST
 * accept, or the operator loses the install at the far end of a build. The
 * reverse - the installer stricter than the panel - costs a retype at a prompt,
 * so it is only reported.
 *
 * The expression is not copied: it is read out of the script and run by bash
 * the way the script runs it. Character ranges match by collation, so the
 * script matches under LC_ALL=C (ASCII); the case runs the same way and, as a
 * second case, under whatever UTF-8 locale the machine has, to show that the
 * locale is what keeps an accented address out.
 */
describe('the ACME email is validated the same way twice', () => {
  const CORPUS = [
    'admin@company.com',
    'a+tag@company.com',
    'a@b.co',
    'admin@sub.company.co.uk',
    'A@COMPANY.COM',
    "o'brien@company.com",
    'аdmin@company.com', // Cyrillic а
    'üser@company.com',
    'admin@примép.com',
    'a@localhost',
    'a@company.c',
    'a b@company.com',
    'a..b@company.com',
    'a@company..com',
    'a@-company.com',
    '.a@company.com',
    'a.@company.com',
    'a@company.com.',
    'a@1.2.3.4',
    '',
  ];

  function installerRegex(): string {
    const m = installerSource().match(/^\s*ACME_EMAIL_RE='(.+)'$/m);
    expect(m, 'ACME_EMAIL_RE was renamed or moved in install-iceslab.sh').not.toBeNull();
    return m![1]!;
  }

  function installerAccepts(re: string, value: string, locale = 'C'): boolean {
    const r = spawnSync('bash', ['-c', 'grep -qE "$1" <<<"$2"', '_', re, value], {
      stdio: 'ignore',
      env: { ...process.env, LC_ALL: locale },
    });
    return r.status === 0;
  }

  const panelAccepts = (v: string) => z.email().safeParse(v).success;

  // The check has to run under LC_ALL=C: without it A-Za-z matches by collation
  // and an accented latin letter gets through to .env.production.
  it('matches under LC_ALL=C, from a here-string, with the extracted expression', () => {
    const check = installerSource()
      .split('\n')
      .find((l) => l.includes('grep') && l.includes('$ACME_EMAIL_RE'));
    expect(check, 'the ACME email check no longer uses the extracted expression').toBeDefined();
    expect(check, 'without LC_ALL=C the ranges match by collation, not by byte').toContain('LC_ALL=C grep -qE');
    expect(check, 'a pipe into grep -q can kill the writer with SIGPIPE under pipefail').toContain('<<<');
  });

  // The environment is no way round it: the same check runs on the value from
  // the prompt and on the one given as ACME_DEFAULT_EMAIL.
  it('checks the address whichever way it came in', () => {
    const src = installerSource();
    const read = src.indexOf('read -r ACME_DEFAULT_EMAIL');
    const check = src.indexOf('grep -qE "$ACME_EMAIL_RE"');
    expect(read).toBeGreaterThan(-1);
    expect(check, 'the check must come after the prompt, outside of its if').toBeGreaterThan(read);
    const between = src.slice(read, check);
    expect(between, 'the check is still inside the prompt branch').toMatch(/\nfi\n/);
  });

  // The script sets LC_ALL=C itself, so the operator's locale does not matter:
  // the diacritic and the doubled dot are refused as under C.
  it('refuses a letter outside ASCII and a doubled dot', () => {
    const re = installerRegex();
    for (const v of ['üser@company.com', 'аdmin@company.com', 'admin@примép.com', 'a..b@company.com']) {
      expect(installerAccepts(re, v), `${v} is accepted`).toBe(false);
    }
  });

  // Addresses the installer took and the panel then refused to boot on (dots at
  // the edges or doubled, a hyphen-leading label). Fixed by the stricter
  // ACME_EMAIL_RE; the list stays as a mechanism so it can only be emptied, not
  // grown: anything the installer accepts that the panel refuses fails here.
  const KNOWN_STRANDING: string[] = [];
  const FORMER_STRANDING = [
    'a..b@company.com',
    'a@company..com',
    'a@-company.com',
    '.a@company.com',
    'a.@company.com',
  ];

  it('rejects the five addresses it used to take and the panel refused', () => {
    const re = installerRegex();
    for (const v of FORMER_STRANDING) {
      expect(installerAccepts(re, v), `${v} is accepted again`).toBe(false);
    }
  });

  it('accepts nothing the panel will refuse', () => {
    const re = installerRegex();

    // Control: the corpus has to contain addresses the installer does accept,
    // or "accepts nothing bad" is true of a check that accepts nothing at all.
    const accepted = CORPUS.filter((v) => installerAccepts(re, v));
    expect(accepted.length, 'the installer accepted none of the corpus').toBeGreaterThan(3);

    const wouldStrandTheOperator = accepted.filter((v) => !panelAccepts(v));
    expect(
      wouldStrandTheOperator,
      'the installer writes these into .env.production and the panel then refuses to boot on them',
    ).toEqual(KNOWN_STRANDING);
  });

  it('is stricter than the panel only in ways worth naming', () => {
    const re = installerRegex();
    // "installer stricter than panel" is the safe direction: refusing at the
    // prompt costs a retype, not an install. It is asserted so the list cannot grow silently.
    const refusedButValid = CORPUS.filter((v) => v !== '' && panelAccepts(v) && !installerAccepts(re, v));
    expect(refusedButValid).toEqual(["o'brien@company.com"]);
  });
});

/**
 * And the reverse direction of the same contract: whether every key the
 * installer writes is a key something reads. A key nobody reads is a setting
 * the operator can put in `.env.production` and watch do nothing.
 *
 * Two readers count: the backend's own schema, and `docker-compose.prod.yml`,
 * which consumes a handful of them (the postgres credentials, the frontend's
 * published address) without the app ever seeing them.
 */
describe('the installer writes no key nobody reads', () => {
  it('every generated key reaches the schema or compose', () => {
    const written = [...templateKeys()];
    expect(written.length, 'the heredoc parsed to almost nothing').toBeGreaterThan(10);

    const config = readFileSync(CONFIG, 'utf8');
    const compose = readFileSync(resolve(HERE, '../../../docker-compose.prod.yml'), 'utf8');
    const inSchema = new Set([...config.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]!));
    expect(inSchema.size, 'no keys parsed out of config.ts').toBeGreaterThan(20);

    const orphans = written.filter((k) => !inSchema.has(k) && !compose.includes('${' + k));
    expect(
      orphans,
      'install-iceslab.sh writes these into .env.production and neither the panel nor compose reads them',
    ).toEqual([]);
  });
});
