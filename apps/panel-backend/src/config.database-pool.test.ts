import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';

/**
 * DATABASE_POOL_MAX is bounded by the schema like every other number. A
 * negative value used to pass `Number(x) || 10`, and node-postgres then never
 * creates a client: every query waits forever and nothing is logged.
 */
const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test_secret_at_least_32_characters_long_for_zod_validation',
  PUBLIC_URL: 'http://localhost:3001',
};

const parse = (v?: string) =>
  ConfigSchema.safeParse({ ...REQUIRED, ...(v === undefined ? {} : { DATABASE_POOL_MAX: v }) });

describe('DATABASE_POOL_MAX', () => {
  it('defaults to 10 when unset', () => {
    const r = parse();
    expect(r.success && r.data.DATABASE_POOL_MAX).toBe(10);
  });

  it.each(['-5', '0', 'abc', '500', '201', '2.5'])('rejects %s at start', (v) => {
    const r = parse(v);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'DATABASE_POOL_MAX')).toBe(true);
  });

  it.each([['1', 1], ['25', 25], ['200', 200]])('accepts %s', (v, n) => {
    const r = parse(v);
    expect(r.success && r.data.DATABASE_POOL_MAX).toBe(n);
  });
});
