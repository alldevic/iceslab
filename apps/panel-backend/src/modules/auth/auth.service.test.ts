import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as adminService from '../admin/admin.service.js';
import { login, InvalidCredentialsError } from './auth.service.js';

vi.mock('../admin/admin.service.js');
// Slice S7 - login now touches Redis for username-lockout. Stub the
// underlying client so unit tests don't need a live Redis. ioredis API
// surface we hit: get / set / incr / expire / del / ttl.
vi.mock('../../lib/infra/redis.js', () => ({
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
 * The counter used to be INCR, then EXPIRE guarded by "this is the first
 * failure". Anything between the two (a Redis blip, a restart) left a key with
 * no expiry, and since the guard fires only on the first increment, nothing set
 * one afterwards either: the window never reset, and ten honest typos spread
 * over a year locked an operator out. The TTL is now created with the key, in
 * one command, before the increment.
 */
describe('the failure counter it leaves behind', () => {
  const failOnce = async () => {
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);
    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  };

  it('gives the key a TTL before it can be non-zero, not after', async () => {
    const { redis } = await import('../../lib/infra/redis.js');
    await failOnce();

    const set = vi.mocked(redis.set);
    const incr = vi.mocked(redis.incr);
    expect(set).toHaveBeenCalledWith(
      expect.stringContaining('1.2.3.4'),
      '0',
      'EX',
      expect.any(Number),
      'NX',
    );
    // Order is the point: a TTL applied after the INCR is a window an
    // interruption can leave open forever.
    expect(set.mock.invocationCallOrder[0]!).toBeLessThan(incr.mock.invocationCallOrder[0]!);
  });

  it('an interruption between the two steps leaves no key without a TTL', async () => {
    const { redis } = await import('../../lib/infra/redis.js');
    vi.mocked(redis.incr).mockRejectedValueOnce(new Error('connection lost'));
    vi.mocked(adminService.findAdminByUsername).mockResolvedValue(fakeAdmin);
    vi.mocked(adminService.verifyPassword).mockResolvedValue(false);

    await expect(login({ username: 'admin', password: 'wrong' }, '1.2.3.4')).rejects.toThrow();
    // The key was created with its expiry before the step that failed.
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      expect.any(String), '0', 'EX', expect.any(Number), 'NX',
    );
  });

  it('does not reach for EXPIRE on an ordinary failure at all', async () => {
    const { redis } = await import('../../lib/infra/redis.js');
    vi.mocked(redis.incr).mockResolvedValue(2);
    await failOnce();
    expect(vi.mocked(redis.expire)).not.toHaveBeenCalled();
  });

  it('still lengthens the TTL when the threshold trips', async () => {
    const { redis } = await import('../../lib/infra/redis.js');
    const { config } = await import('../../config.js');
    vi.mocked(redis.incr).mockResolvedValue(config.LOGIN_LOCKOUT_FAILURES);
    await failOnce();
    expect(vi.mocked(redis.expire)).toHaveBeenCalledWith(
      expect.stringContaining('1.2.3.4'),
      config.LOGIN_LOCKOUT_DURATION_MIN * 60,
    );
  });
});
