import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';

/**
 * The webhook sender with the facade off, or on without a URL and a secret:
 * nothing is read, nothing is sent, and the cron job is not in the schedule.
 * The flag and keys are changed on a mutable copy of the config per case; the
 * schedule is fixed when the scheduler module loads, so the "on" case loads a
 * second copy with the environment set.
 */

// The real config is frozen; a mutable copy lets each case set the flag and keys.
vi.mock('../../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../config.js')>();
  return { ...mod, config: { ...mod.config } };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let webhook: any;
let events: any;
let prisma: any;
let config: any;
let eventBus: any;
let redis: any;
let registerCronJobs: any;
let closeFirstRedis: () => Promise<void>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const KEYS = ['REMNAWAVE_COMPAT_ENABLED', 'REMNAWAVE_COMPAT_WEBHOOK_URL', 'REMNAWAVE_COMPAT_WEBHOOK_SECRET'] as const;
const URL_OK = 'http://127.0.0.1:9/panel';
const UID = '00000000-0000-4000-8000-000000000001';

let fetchMock: ReturnType<typeof vi.fn>;
const original: Record<string, unknown> = {};

beforeAll(async () => {
  // The default environment: facade off. Registered once, like index.ts does.
  delete process.env['REMNAWAVE_COMPAT_ENABLED'];
  config = (await import('../../config.js')).config;
  webhook = await import('./remnawave.webhook.js');
  events = await import('./remnawave.webhook.events.js');
  prisma = (await import('../../prisma.js')).prisma;
  eventBus = (await import('../../lib/infra/event-bus.js')).eventBus;
  const redisMod = await import('../../lib/infra/redis.js');
  redis = redisMod.redis;
  closeFirstRedis = redisMod.closeRedis;
  registerCronJobs = (await import('../scheduler/scheduler.queue.js')).registerCronJobs;
  for (const k of KEYS) original[k] = config[k];
  events.registerRemnawaveWebhookEmitter();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeFirstRedis();
});

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of KEYS) config[k] = original[k];
});

const CASES: [string, boolean, string | undefined, string | undefined][] = [
  ['the facade off, URL and secret set', false, URL_OK, 'secret'],
  ['the facade on, no URL', true, undefined, 'secret'],
  ['the facade on, no secret', true, URL_OK, undefined],
  ['the facade on, URL and secret blank', true, undefined, undefined],
];

describe.each(CASES)('%s', (_label, enabled, url, secret) => {
  beforeEach(() => {
    config.REMNAWAVE_COMPAT_ENABLED = enabled;
    config.REMNAWAVE_COMPAT_WEBHOOK_URL = url;
    config.REMNAWAVE_COMPAT_WEBHOOK_SECRET = secret;
  });

  it('is not configured, scans without touching the database and delivers nothing', async () => {
    const findMany = vi.spyOn(prisma.user, 'findMany');
    const findUnique = vi.spyOn(prisma.user, 'findUnique');

    expect(webhook.isRemnaWebhookConfigured()).toBe(false);
    expect(await webhook.scanRemnaExpiryNotifications()).toBe(0);
    expect(
      await webhook.deliverRemnaWebhook('user.expired', { id: 'u', telegramId: null, email: null, expireAt: null }),
    ).toBe(false);
    webhook.emitRemnaWebhookForUser('user.expired', UID);
    await new Promise((r) => setTimeout(r, 20));

    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('has handlers that send nothing on user.status-changed or hwid.device-added', async () => {
    const findUnique = vi.spyOn(prisma.user, 'findUnique');

    eventBus.emit('user.status-changed', { userId: UID, from: 'active', to: 'expired' });
    eventBus.emit('hwid.device-added', {
      userId: UID,
      deviceId: '00000000-0000-4000-8000-000000000002',
      hwid: 'h',
      firstSeenAt: new Date(),
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the cron job', () => {
  const schedule = async (queue: Queue) => (await queue.getJobSchedulers()).map((s) => s.key);

  it('is not registered with the facade off', async () => {
    const queue = new Queue(`cron-off-${randomUUID()}`, { connection: redis });
    try {
      await registerCronJobs(queue);
      expect(await schedule(queue)).not.toContain('remnawave-expiry-notify');
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('is registered every ten minutes with the facade on', async () => {
    vi.resetModules();
    vi.doUnmock('../../config.js');
    process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
    try {
      const { registerCronJobs: register } = await import('../scheduler/scheduler.queue.js');
      const { redis: onRedis, closeRedis } = await import('../../lib/infra/redis.js');
      const queue = new Queue(`cron-on-${randomUUID()}`, { connection: onRedis });
      try {
        await register(queue);
        const found = (await queue.getJobSchedulers()).find((s) => s.key === 'remnawave-expiry-notify');
        expect(found?.pattern).toBe('*/10 * * * *');
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        await closeRedis();
      }
    } finally {
      delete process.env['REMNAWAVE_COMPAT_ENABLED'];
    }
  });
});
