import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';

/** GEO_SELF_HOST, GEO_ARTIFACT_TOKEN and RATE_LIMIT_GEO_PER_MIN (milestone 10.4). */
const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@postgres:5432/iceslab',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://panel.example.com',
};
const parse = (env: Record<string, string> = {}) => ConfigSchema.safeParse({ ...REQUIRED, ...env });

describe('geo self-hosting settings', () => {
  it('defaults: off, no token, 60 a minute', () => {
    const r = parse();
    expect(r.success && [r.data.GEO_SELF_HOST, r.data.GEO_ARTIFACT_TOKEN, r.data.RATE_LIMIT_GEO_PER_MIN]).toEqual([false, undefined, 60]);
  });

  it('the flag reads true and 1, nothing else', () => {
    for (const [v, want] of [['true', true], ['TRUE', true], ['1', true], ['false', false], ['yes', false], ['', false]] as const) {
      const r = parse({ GEO_SELF_HOST: v });
      expect(r.success && r.data.GEO_SELF_HOST, v).toBe(want);
    }
  });

  it('a blank token is no token (compose passes ${VAR:-})', () => {
    for (const v of ['', '   ']) {
      const r = parse({ GEO_ARTIFACT_TOKEN: v });
      expect(r.success && r.data.GEO_ARTIFACT_TOKEN, JSON.stringify(v)).toBeUndefined();
    }
  });

  it('a token is taken as given, trimmed', () => {
    const r = parse({ GEO_ARTIFACT_TOKEN: ' my-geo_token-0123456789 ' });
    expect(r.success && r.data.GEO_ARTIFACT_TOKEN).toBe('my-geo_token-0123456789');
  });

  it('a short token and a token that is not a path segment stop the boot', () => {
    expect(parse({ GEO_ARTIFACT_TOKEN: 'short' }).success).toBe(false);
    expect(parse({ GEO_ARTIFACT_TOKEN: 'has/slash/0123456789' }).success).toBe(false);
    expect(parse({ GEO_ARTIFACT_TOKEN: 'has space 0123456789' }).success).toBe(false);
  });

  it('the rate takes a positive integer', () => {
    expect(parse({ RATE_LIMIT_GEO_PER_MIN: '10' }).success).toBe(true);
    expect(parse({ RATE_LIMIT_GEO_PER_MIN: '0' }).success).toBe(false);
  });
});

/** SINGBOX_BIN (milestone 10.5): optional, read where it is used (lib/util/singbox-bin.ts). */
describe('SINGBOX_BIN', () => {
  it('is optional, and blank is unset', () => {
    for (const v of [undefined, '', '  ']) {
      const r = parse(v === undefined ? {} : { SINGBOX_BIN: v });
      expect(r.success && r.data.SINGBOX_BIN, JSON.stringify(v)).toBeUndefined();
    }
  });

  it('a path is taken as given, trimmed', () => {
    const r = parse({ SINGBOX_BIN: ' /usr/local/bin/sing-box ' });
    expect(r.success && r.data.SINGBOX_BIN).toBe('/usr/local/bin/sing-box');
  });
});
