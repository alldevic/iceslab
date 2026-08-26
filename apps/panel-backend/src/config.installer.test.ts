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

/**
 * The ACME email, validated twice.
 *
 * `install-iceslab.sh` asks for it at a prompt and checks it with a bash
 * regular expression; the panel checks the same value with `z.email()` when it
 * boots. The two are one decision written in two languages, and the comment in
 * the installer is what holds them together — a comment that also records the
 * scar: on 2026-08-10 an operator typed one Cyrillic letter, the installer took
 * it, and the panel refused to boot on it eleven minutes later at step 9 of 9,
 * reported as "container is unhealthy".
 *
 * The rule is one-directional and that is the point. Anything the installer
 * accepts the panel MUST accept, or the operator loses the install at the far
 * end of a ten-minute build. The reverse — the installer stricter than the
 * panel — costs a retype at a prompt, so it is reported here rather than
 * failed.
 *
 * The expression is not copied. It is read out of the script and run by bash,
 * under the same LC_ALL the script sets, because the first fix was wrong about
 * exactly that: `[[ =~ ]]` matches by collation, so under a UTF-8 locale
 * `A-Za-z` covers accented latin and `üser@example.com` passed. Cyrillic was
 * rejected only because it collates outside the latin range — the fix covered
 * the one keyboard it was written for.
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
    const src = installerSource();
    const m = src.match(/^\s*ACME_EMAIL_RE='(.+)'$/m);
    expect(m, 'ACME_EMAIL_RE was renamed or moved in install-iceslab.sh').not.toBeNull();
    return m![1]!;
  }

  function installerAccepts(re: string, value: string): boolean {
    // Run by bash, from the script's own text, under the script's own locale
    // setting. A JS reimplementation of an ERE would be a third opinion.
    const r = spawnSync(
      'bash',
      ['-c', 'LC_ALL=C grep -qE "$1" <<<"$2"', '_', re, value],
      { stdio: 'ignore' },
    );
    return r.status === 0;
  }

  const panelAccepts = (v: string) => z.email().safeParse(v).success;

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
    ).toEqual([]);
  });

  it('does the matching under LC_ALL=C, which is what makes A-Za-z mean ASCII', () => {
    // The case above runs the regex under LC_ALL=C because the script does. If
    // the script stopped doing that, the case above would keep passing and the
    // installer would go back to accepting accented latin — so the locale is
    // asserted at the script, and then demonstrated to be load-bearing.
    const src = installerSource();
    const check = src
      .split('\n')
      .find((l) => l.includes('ACME_EMAIL_RE') && l.includes('grep'));
    expect(check, 'the ACME email check no longer uses the extracted expression').toBeDefined();
    expect(check, 'without LC_ALL=C the character ranges match by collation, not by byte').toContain(
      'LC_ALL=C',
    );

    // And here is what that buys, measured rather than asserted from memory:
    // the same expression, the same input, the collating locale.
    const re = installerRegex();
    const underCollation = spawnSync(
      'bash',
      ['-c', 'LC_ALL=en_US.UTF-8 grep -qE "$1" <<<"$2"', '_', re, 'üser@company.com'],
      { stdio: 'ignore' },
    );
    const underBytes = installerAccepts(re, 'üser@company.com');
    expect(underBytes, 'an accented latin local part must be refused').toBe(false);
    if (underCollation.status === 0) {
      // The locale really is the only thing standing between this address and
      // .env.production. If a future libc stops collating it that way this
      // branch simply does not run; the assertion above is the one that matters.
      expect(panelAccepts('üser@company.com')).toBe(false);
    }
  });

  it('is stricter than the panel only in ways worth naming', () => {
    const re = installerRegex();
    // Not a failure: refusing at the prompt costs a retype, not an install. It
    // is asserted so the list cannot grow silently.
    const refusedButValid = CORPUS.filter((v) => v !== '' && panelAccepts(v) && !installerAccepts(re, v));
    expect(refusedButValid).toEqual(["o'brien@company.com"]);
  });
});

/**
 * And the reverse direction of the same contract.
 *
 * The check at the top of this file asks whether every key `config.ts` REQUIRES
 * is one the installer writes — the direction that stops a fresh panel from
 * booting. This asks the other one: whether every key the installer writes is a
 * key something reads. A key nobody reads is a setting the operator can put in
 * `.env.production` and watch do nothing, which is how NAIVE_BINARY sat in the
 * node's env file with the path to caddy in it (see
 * apps/node/main_envcontract_test.go, the same slice pointed at the other
 * half of the deployment).
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
    const compose = readFileSync(
      resolve(HERE, '../../../docker-compose.prod.yml'),
      'utf8',
    );
    // The schema declares its keys as object properties; compose interpolates
    // them as ${KEY} or ${KEY:-default}.
    const inSchema = new Set(
      [...config.matchAll(/^\s{2}([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]!),
    );
    expect(inSchema.size, 'no keys parsed out of config.ts').toBeGreaterThan(20);

    const orphans = written.filter(
      (k) => !inSchema.has(k) && !compose.includes('${' + k),
    );
    expect(
      orphans,
      'install-iceslab.sh writes these into .env.production and neither the panel nor compose reads them',
    ).toEqual([]);
  });
});
