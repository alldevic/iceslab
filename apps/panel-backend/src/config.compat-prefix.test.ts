import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';
import { HONEYPOT_PREFIXES } from './lib/auth/honeypot-paths.js';

/**
 * REMNAWAVE_COMPAT_PREFIX: the one path segment the Remnawave facade is
 * mounted under. A bad value stops the boot, so it must be refused for the
 * reasons that would otherwise break routing at runtime.
 */
const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@postgres:5432/iceslab',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://panel.example.com',
};
const parse = (env: Record<string, string> = {}) => ConfigSchema.safeParse({ ...REQUIRED, ...env });
const prefix = (v: string, extra: Record<string, string> = {}) =>
  parse({ REMNAWAVE_COMPAT_PREFIX: v, ...extra });
const message = (r: ReturnType<typeof parse>) => JSON.stringify(r.success ? [] : r.error.issues);

describe('REMNAWAVE_COMPAT_PREFIX', () => {
  it('defaults to rw', () => {
    const r = parse();
    expect(r.success && r.data.REMNAWAVE_COMPAT_PREFIX).toBe('rw');
    expect(r.success && r.data.REMNAWAVE_COMPAT_ENABLED).toBe(false);
  });

  it('takes one segment of [a-zA-Z0-9_-]', () => {
    for (const v of ['rw', 'remna', 'panel-api', 'x_1', 'RW2']) {
      const r = prefix(v);
      expect(r.success && r.data.REMNAWAVE_COMPAT_PREFIX, v).toBe(v);
    }
  });

  it('refuses an empty value', () => {
    expect(prefix('').success).toBe(false);
  });

  it('refuses a slash, a nested path and other characters', () => {
    for (const v of ['/rw', 'rw/', 'a/b', 'rw.x', 'r w', 'rw?x']) {
      expect(prefix(v).success, v).toBe(false);
    }
  });

  it('refuses the names the panel owns, in any case', () => {
    for (const v of ['api', 'admin', 'health', 'assets', 'geo', 'GEO', 'API', 'Admin']) {
      const r = prefix(v);
      expect(r.success, v).toBe(false);
      expect(message(r), v).toContain('Taken by the panel itself');
    }
  });

  it('refuses the subscription prefix, however it is spelled', () => {
    const same = prefix('sub');
    expect(same.success).toBe(false);
    expect(message(same)).toContain('SUBSCRIPTION_PATH_PREFIX');
    expect(prefix('Feed', { SUBSCRIPTION_PATH_PREFIX: '/feed' }).success).toBe(false);
    // Another segment is fine, and the default rw is fine beside /sub.
    expect(prefix('feed', { SUBSCRIPTION_PATH_PREFIX: '/sub' }).success).toBe(true);
    expect(parse({ SUBSCRIPTION_PATH_PREFIX: '/rw' }).success).toBe(false);
  });

  it('refuses a honeypot trap prefix, which would blacklist the shop', () => {
    const traps = HONEYPOT_PREFIXES.filter((p) => /^\/[a-zA-Z0-9_-]+$/.test(p)).map((p) => p.slice(1));
    expect(traps.length).toBeGreaterThan(0);
    for (const v of traps) {
      const r = prefix(v);
      expect(r.success, v).toBe(false);
      expect(message(r), v).toContain('honeypot trap prefix');
    }
  });
});
