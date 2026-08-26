import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigSchema } from './config.js';
import { fileURLToPath } from 'node:url';

/**
 * Settings the panel validates, documents and passes through — and reads
 * nowhere.
 *
 * `config.ts` is the one place an environment variable becomes real: it is
 * parsed, type-checked and frozen, and a bad value stops the boot with a clear
 * message. That makes a key declared there look load-bearing from every angle.
 * `.env.production.example` offers it, `docker-compose.prod.yml` passes it
 * through, `config.compose-passthrough.test.ts` pins that passthrough — and if
 * no code ever reads it, an operator who sets it gets exactly nothing, with a
 * whole stack of evidence saying otherwise.
 *
 * This is the same shape as the node's REALISTIC_FALLBACK, which the panel
 * showed as an enabled probe-resistance toggle on a node where nothing read
 * the flag. That one was found by comparing the keys the installer WRITES
 * against the ones the agent READS; this is the same slice pointed at the
 * panel's own half.
 *
 * Seven are on the exception list below, each pre-profile legacy: the values
 * they name now live per-profile, on the inbound config a binding carries.
 * The list is meant to shrink and never to grow quietly, and it is asserted in
 * both directions so an excuse cannot outlive its subject.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, 'config.ts');

/**
 * Declared and read by nothing, with the reason. Removing them is an
 * operator-facing surface change and therefore a product call; naming them
 * here is what stops the surface growing while that call is outstanding.
 */
const KNOWN_UNREAD: Record<string, string> = {
  XRAY_FLOW: 'pre-profile default; flow now lives on the profile config',
  XRAY_FINGERPRINT: 'pre-profile default; fingerprint now lives on the profile config',
  XRAY_PUBLIC_PORT: 'pre-binding default; the client-facing port now comes from the binding',
  XRAY_REALITY_SNI: 'pre-profile default; realityServerNames now lives on the profile config',
  XRAY_REALITY_PUBLIC_KEY: 'pre-profile default; the REALITY pair now lives on the profile config',
  XRAY_REALITY_SHORT_ID: 'pre-profile default; realityShortIds now lives on the profile config',
  HYSTERIA_PUBLIC_PORT:
    'pre-binding default; the hysteria2 link port now comes from the binding, ' +
    'though a comment in subscription.routes.test.ts still claimed otherwise',
};

/** Top-level keys of the zod object in config.ts. */
function declaredKeys(): string[] {
  const src = readFileSync(CONFIG, 'utf8');
  const keys = [...src.matchAll(/^ {2}([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]!);
  expect(keys.length, 'the schema no longer parses as one key per indented line').toBeGreaterThan(30);
  return [...new Set(keys)];
}

/** Every non-test source file under src/, minus the generated client. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'generated' || name === 'node_modules') continue;
        walk(p);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      out.push(p);
    }
  };
  walk(HERE);
  return out;
}

/**
 * config.ts is part of the body, minus its own declaration lines.
 *
 * Excluding the file outright was the first attempt and it was wrong:
 * SUBSCRIPTION_PUBLIC_URL is read inside config.ts by `subscriptionOrigin()`,
 * the exported helper both link producers go through, and dropping the file
 * made a live setting look dead. Stripping only `  KEY:` keeps a declaration
 * from counting as a read while leaving every real use in place.
 */
function readableBody(): string {
  return sources()
    .map((p) => {
      const src = readFileSync(p, 'utf8');
      return resolve(p) === resolve(CONFIG)
        ? src.replace(/^ {2}[A-Z][A-Z0-9_]{2,}:.*$/gm, '')
        : src;
    })
    .join('\n');
}

describe('every setting the panel declares is a setting it reads', () => {
  const body = readableBody();

  it('reads the sources it is comparing against', () => {
    // The control. An empty body would make every key look unread, and an
    // over-broad one would make every key look read.
    expect(body.length).toBeGreaterThan(100_000);
    expect(body).toContain('config.DATABASE_URL');
  });

  it('leaves no declared key unread except the ones named here', () => {
    const unread = declaredKeys().filter(
      (k) => !new RegExp(`\\b${k}\\b`).test(body) && !(k in KNOWN_UNREAD),
    );
    expect(
      unread.sort(),
      'declared in config.ts, offered in .env.production.example, passed through by compose — and read by nothing',
    ).toEqual([]);
  });

  it('keeps no excuse for a key that is read after all', () => {
    // An entry that stops being true hides the next real one behind it.
    const stale = Object.keys(KNOWN_UNREAD).filter((k) => new RegExp(`\\b${k}\\b`).test(body));
    expect(stale.sort(), 'listed as unread, but something reads them now').toEqual([]);
  });

  it('keeps no excuse for a key the schema no longer declares', () => {
    const declared = new Set(declaredKeys());
    const gone = Object.keys(KNOWN_UNREAD).filter((k) => !declared.has(k));
    expect(gone.sort(), 'listed as unread, but no longer declared at all').toEqual([]);
  });
});

/**
 * The one setting that used to have no schema behind it.
 *
 * `DATABASE_POOL_MAX` was read as `Number(process.env.DATABASE_POOL_MAX) || 10`
 * straight in prisma.ts. That guard catches NaN and catches 0 and lets a
 * NEGATIVE through, and node-postgres creates clients while
 * `clients.length < max` — which for a negative max is never. Measured: with
 * max 10 a connection to a dead address fails in 3ms with ECONNREFUSED; with
 * max -5 the promise never settles at all, connectionTimeoutMillis included.
 *
 * So a typo'd number did not crash the panel and did not log: it turned it into
 * a process that answers nothing, /health among them, because pingDatabase()
 * queries. Bounded in config.ts now, where a bad value stops the boot and says
 * which variable it was.
 */
describe('the connection-pool ceiling', () => {
  it('is declared in the schema rather than read raw', () => {
    const cfg = readFileSync(CONFIG, 'utf8');
    expect(cfg).toMatch(/^ {2}DATABASE_POOL_MAX:/m);

    const prismaSrc = readFileSync(join(HERE, 'prisma.ts'), 'utf8');
    expect(prismaSrc).toContain('config.DATABASE_POOL_MAX');
    expect(
      prismaSrc,
      'reading it off process.env again would put it back outside the schema',
    ).not.toContain('process.env.DATABASE_POOL_MAX');
  });

  it('is bounded on both sides', () => {
    // Same four settings the other config tests use to get a parseable
    // environment; only DATABASE_POOL_MAX varies.
    const REQUIRED = {
      DATABASE_URL: 'postgresql://user:pass@postgres:5432/iceslab',
      REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: 'x'.repeat(32),
      PUBLIC_URL: 'https://panel.example.com',
    };

    // A pool that can never hand out a connection, a value that is not one, and
    // one past the ceiling — postgres ships with max_connections 100, so a
    // panel asking for 500 exhausts the server the bound exists to protect.
    for (const bad of ['-5', '0', 'abc', '500']) {
      expect(
        ConfigSchema.safeParse({ ...REQUIRED, DATABASE_POOL_MAX: bad }).success,
        `${bad} was accepted as a pool size`,
      ).toBe(false);
    }

    // The control: a sane value still parses, or "rejects the bad ones" is
    // true of a schema that rejects everything.
    const ok = ConfigSchema.safeParse({ ...REQUIRED, DATABASE_POOL_MAX: '25' });
    expect(ok.success, 'a valid pool size was rejected too').toBe(true);
    if (ok.success) expect(ok.data.DATABASE_POOL_MAX).toBe(25);

    // And the default is still what prisma.ts documented.
    const fallback = ConfigSchema.safeParse(REQUIRED);
    expect(fallback.success).toBe(true);
    if (fallback.success) expect(fallback.data.DATABASE_POOL_MAX).toBe(10);
  });
});
