import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, RESERVED_PATH_PREFIXES } from './config.js';
import { HONEYPOT_PREFIXES } from './lib/auth/honeypot-paths.js';

/**
 * The honeypot traps its prefixes on every path, so a subscription mounted on
 * one gets a fake 404 and a blacklisted subscriber. The config refuses them,
 * and so does the frontend entrypoint (same list, checked below).
 */
const parse = (v: string) => ConfigSchema.shape.SUBSCRIPTION_PATH_PREFIX.safeParse(v);
// The prefix pattern is one segment of [a-zA-Z0-9_-], so `/.git/` can never be
// configured; the entrypoint still lists it so the two lists stay identical.
const configurable = HONEYPOT_PREFIXES.filter((p) => /^\/[a-zA-Z0-9_-]+$/.test(p));

describe('SUBSCRIPTION_PATH_PREFIX against the honeypot', () => {
  it.each(configurable)('refuses %s, naming it', (trap) => {
    const r = parse(trap);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(`honeypot trap prefix ${trap}`);
  });

  it.each(configurable)('refuses a prefix nested under %s, in any case', (trap) => {
    for (const v of [`${trap}x`, `${trap}-2`, trap.toUpperCase()]) {
      const r = parse(v);
      expect(r.success, v).toBe(false);
      expect(JSON.stringify(r.error?.issues), v).toContain(`honeypot trap prefix ${trap}`);
    }
  });

  it('takes a prefix that does not collide', () => {
    for (const p of ['/sub', '/wp', '/word', '/press', '/php', '/server-status']) {
      expect(parse(p).success, p).toBe(true);
    }
  });

  it('keeps the panel-route reservation', () => {
    expect(RESERVED_PATH_PREFIXES).toEqual(['/api', '/admin', '/health', '/assets']);
  });
});

describe('the frontend entrypoint', () => {
  const script = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../panel-frontend/docker-entrypoint.d/15-subscription-prefix.sh',
  );
  const run = (prefix: string) => {
    try {
      execFileSync('sh', [script], { env: { SUBSCRIPTION_PATH_PREFIX: prefix, PATH: process.env.PATH }, stdio: 'pipe' });
      return { ok: true, err: '' };
    } catch (e) {
      return { ok: false, err: String((e as { stderr?: Buffer }).stderr ?? '') };
    }
  };

  it('lists the same honeypot prefixes as the backend', () => {
    const src = readFileSync(script, 'utf8');
    const line = /\n {2}(\/wp-admin\*[^)]*)\)/.exec(src);
    expect(line, 'the honeypot case line is missing').not.toBeNull();
    const listed = line![1]!.split('|').map((s) => s.trim().replace(/\*$/, ''));
    expect(listed).toEqual([...HONEYPOT_PREFIXES].map((p) => p.replace(/\/$/, '/')));
  });

  it.each(configurable)('refuses %s and a nested path like the backend', (trap) => {
    for (const v of [trap, `${trap}x`, trap.toUpperCase()]) {
      const r = run(v);
      expect(r.ok, v).toBe(false);
      expect(r.err, v).toContain('honeypot');
    }
  });

  it('accepts a non-colliding prefix', () => {
    expect(run('/sub').ok).toBe(true);
  });
});
