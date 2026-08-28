import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as adminService from '../admin/admin.service.js';
import { login, InvalidCredentialsError } from './auth.service.js';

vi.mock('../admin/admin.service.js');
// Slice S7 - login now touches Redis for username-lockout. Stub the
// underlying client so unit tests don't need a live Redis. ioredis API
// surface we hit: get / incr / expire / del / ttl.
vi.mock('../../lib/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-1),
  },
}));

const fakeAdmin = {
  id: '11111111-1111-1111-1111-111111111111',
  username: 'admin',
  passwordHash: '$2b$12$fakeHash',
  role: 'admin',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('login', () => {
  it('returns the admin record on valid credentials', async () => {
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(true);

    const result = await login({ username: 'admin', password: 'correct' }, '1.2.3.4');
    expect(result).toBe(fakeAdmin);
    expect(adminService.findAdminByUsername).toHaveBeenCalledWith('admin');
    expect(adminService.verifyPassword).toHaveBeenCalledWith('correct', fakeAdmin.passwordHash);
  });

  it('throws InvalidCredentialsError when admin does not exist', async () => {
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(null);

    await expect(login({ username: 'ghost', password: 'whatever' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(adminService.verifyPassword).not.toHaveBeenCalled();
  });

  it('throws InvalidCredentialsError when password is wrong', async () => {
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);

    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

/**
 * What the lockout counter leaves in Redis when something interrupts it.
 *
 * The counter used to be INCR, then EXPIRE, with the EXPIRE guarded by "this
 * is the first failure". Anything between the two — a Redis blip, a restart,
 * the fail-fast client refusing one command — left a key with no expiry, and
 * since the guard only fires on the first increment, nothing set one
 * afterwards either. The window then never resets, so ten honest typos spread
 * over a year lock a real operator out of their own panel, and the only way to
 * see it is `ttl` answering -1 on a key nobody knows to look for.
 *
 * The per-IP counter on /sub had already been fixed this way, comment and all.
 * This is the same decision in a second place.
 */
describe('the failure counter it leaves behind', () => {
  it('gives the key a TTL before it can be non-zero, not after', async () => {
    const { redis } = await import('../../lib/redis.js');
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);

    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const set = vi.mocked(redis.set);
    const incr = vi.mocked(redis.incr);
    expect(set, 'the counter key is created with its expiry in one command').toHaveBeenCalledWith(
      expect.stringContaining('1.2.3.4'),
      '0',
      'EX',
      expect.any(Number),
      'NX',
    );
    // Order is the whole point: a TTL applied after the INCR is a window that
    // an interruption can leave open forever.
    expect(set.mock.invocationCallOrder[0]!).toBeLessThan(incr.mock.invocationCallOrder[0]!);
    // And NX, so a second failure inside the window does not restart it.
    expect(set.mock.calls[0]!.at(-1)).toBe('NX');
  });

  it('does not reach for EXPIRE on an ordinary failure at all', async () => {
    const { redis } = await import('../../lib/redis.js');
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);
    vi.mocked(redis.incr).mockResolvedValue(2);

    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    // Below the threshold there is nothing left to do: the expiry already
    // exists. An EXPIRE here would be the old two-round-trip shape returning.
    expect(vi.mocked(redis.expire)).not.toHaveBeenCalled();
  });

  it('still lengthens the TTL when the threshold trips', async () => {
    const { redis } = await import('../../lib/redis.js');
    const { config } = await import('../../config.js');
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);
    vi.mocked(redis.incr).mockResolvedValue(config.LOGIN_LOCKOUT_FAILURES);

    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(vi.mocked(redis.expire)).toHaveBeenCalledWith(
      expect.stringContaining('1.2.3.4'),
      config.LOGIN_LOCKOUT_DURATION_MIN * 60,
    );
  });
});
