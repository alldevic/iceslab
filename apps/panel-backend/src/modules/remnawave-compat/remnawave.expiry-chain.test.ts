import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The expiry notification path, end to end — the one that decides whether a
 * subscriber is charged.
 *
 * `user.expires_in_24_hours` is the shop's ONLY auto-renew charge trigger, and
 * `user.expired` is how the shop learns a subscription ended. Both are emitted
 * from here, and until now neither the scan that produces the first nor the
 * event wiring that produces the second was exercised by anything: the scan had
 * no test at all, and the emitter's registration was called only from
 * `index.ts`. A hook that is never registered in a test is a hook that can be
 * unregistered without a single test noticing - which is exactly the shape of
 * defect this integration keeps producing.
 */

const SECRET = 'chain-secret';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webhook: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redis: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cron: any;

interface Sent {
  name: string;
  uuid: string;
  expireAt: string | null;
}
let sent: Sent[] = [];
let respondOk = true;

const HOUR = 3_600_000;
const cohortIds: string[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_URL'] = 'http://127.0.0.1:9/panel';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_SECRET'] = SECRET;
  webhook = await import('./remnawave.webhook.js');
  prisma = (await import('../../prisma.js')).prisma;
  redis = (await import('../../lib/redis.js')).redis;
  cron = await import('../users/users.cron.js');
});

afterAll(async () => {
  await prisma.userTraffic.deleteMany({ where: { user: { id: { in: cohortIds } } } });
  await prisma.user.deleteMany({ where: { id: { in: cohortIds } } });
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

beforeEach(() => {
  sent = [];
  respondOk = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({
        name: body.name,
        uuid: body.payload.user.uuid,
        expireAt: body.payload.user.expireAt,
      });
      return respondOk
        ? ({ ok: true, status: 200 } as Response)
        : ({ ok: false, status: 503 } as Response);
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // The dedup keys outlive the process by design (8 days), so a test that left
  // one behind would silence the next one.
  //
  // Scoped to THIS file's users, by id. `.env.test` and the lab's `.env` point
  // at the same Redis on the same database index, so `keys('rw:expnotify:*')`
  // followed by a del would reach into the running panel and drop the claims it
  // had already made - it would then re-send expiry webhooks it considers
  // delivered. Same shape as the DATABASE_URL trap: a test that reaches past its
  // own fixtures into shared live state, and says nothing while doing it.
  const keys: string[] = [];
  for (const id of cohortIds) keys.push(...(await redis.keys(`rw:expnotify:${id}:*`)));
  if (keys.length) await redis.del(...keys);
});

let seq = 0;
async function user(opts: { status?: string; expiresInMs: number | null; deleted?: boolean } = { expiresInMs: null }) {
  const { generateUserCredentials } = await import('../../lib/credentials.js');
  seq += 1;
  const creds = generateUserCredentials();
  const row = await prisma.user.create({
    data: {
      username: `chain-${Date.now()}-${seq}`,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
      status: opts.status ?? 'active',
      expireAt: opts.expiresInMs === null ? null : new Date(Date.now() + opts.expiresInMs),
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
  cohortIds.push(row.id);
  return row.id as string;
}

/** Only what this test made — the suite shares one database. */
function mine(id: string): Sent[] {
  return sent.filter((s) => s.uuid === id);
}

describe('scanRemnaExpiryNotifications', () => {
  it('picks the stage from the time left, not from a fixed schedule', async () => {
    const in70 = await user({ expiresInMs: 70 * HOUR });
    const in40 = await user({ expiresInMs: 40 * HOUR });
    const in10 = await user({ expiresInMs: 10 * HOUR });

    await webhook.scanRemnaExpiryNotifications();

    expect(mine(in70).map((s) => s.name)).toEqual(['user.expires_in_72_hours']);
    expect(mine(in40).map((s) => s.name)).toEqual(['user.expires_in_48_hours']);
    expect(mine(in10).map((s) => s.name)).toEqual(['user.expires_in_24_hours']);
  });

  it('notifies a subscriber who is limited on quota, whose term is still closing', async () => {
    // The 24h stage is the shop's only charge trigger. Scanning 'active' alone
    // starved auto-renew for exactly the subscribers most likely to renew: the
    // ones who used the service enough to hit the cap.
    const limited = await user({ status: 'limited', expiresInMs: 10 * HOUR });
    await webhook.scanRemnaExpiryNotifications();
    expect(mine(limited).map((s) => s.name)).toEqual(['user.expires_in_24_hours']);
  });

  it('says nothing about users it has no business notifying', async () => {
    const disabled = await user({ status: 'disabled', expiresInMs: 10 * HOUR });
    const expired = await user({ status: 'expired', expiresInMs: 10 * HOUR });
    const deleted = await user({ expiresInMs: 10 * HOUR, deleted: true });
    const farOff = await user({ expiresInMs: 100 * HOUR });
    const gone = await user({ expiresInMs: -1 * HOUR }); // already past
    const endless = await user({ expiresInMs: null });

    await webhook.scanRemnaExpiryNotifications();

    for (const id of [disabled, expired, deleted, farOff, gone, endless]) {
      expect(mine(id)).toEqual([]);
    }
  });

  it('does not send the same stage twice for the same cycle', async () => {
    const id = await user({ expiresInMs: 10 * HOUR });

    expect(await webhook.scanRemnaExpiryNotifications()).toBeGreaterThanOrEqual(1);
    await webhook.scanRemnaExpiryNotifications();

    // Scoped to this user, deliberately: the scan reads EVERY user on the panel
    // and the suite shares one database, so `sent` also carries whatever other
    // files left inside the 72h window. Asserting on the global count would
    // make this test fail whenever somebody else's fixture happens to sit near
    // a stage boundary - a red run that says nothing about the dedup.
    expect(mine(id)).toHaveLength(1);
  });

  it('re-arms after a renewal, which is what makes a sub-24h cadence work', async () => {
    // The dedup key carries the exact expireAt, so a renewal is a new cycle and
    // gets its own charge trigger. Without this, a term shorter than the dedup
    // window would be charged once and then silently lapse on every renewal
    // after it.
    const id = await user({ expiresInMs: 10 * HOUR });
    await webhook.scanRemnaExpiryNotifications();
    expect(mine(id)).toHaveLength(1);

    await prisma.user.update({
      where: { id },
      data: { expireAt: new Date(Date.now() + 12 * HOUR) },
    });
    await webhook.scanRemnaExpiryNotifications();

    const forMe = mine(id);
    expect(forMe).toHaveLength(2);
    expect(forMe[0]!.expireAt).not.toBe(forMe[1]!.expireAt);
    expect(forMe.every((s) => s.name === 'user.expires_in_24_hours')).toBe(true);
  });

  it('claims the cycle only on a confirmed 2xx, so a failed tick retries', async () => {
    const id = await user({ expiresInMs: 10 * HOUR });

    respondOk = false;
    expect(await webhook.scanRemnaExpiryNotifications()).toBe(0);
    expect(mine(id)).toHaveLength(1); // attempted

    respondOk = true;
    await webhook.scanRemnaExpiryNotifications();
    expect(mine(id)).toHaveLength(2); // and retried, rather than written off
  });
});

describe('the expiry cron reaches the shop', () => {
  it('delivers user.expired for a subscriber who was limited when the term ended', async () => {
    // Both halves of this were tested apart: the cron emits status-changed with
    // from='limited', and the emitter delivers when called. Neither says the
    // two are connected. They are connected by a registration in index.ts, and
    // an unregistered hook is a webhook nobody ever sends with a green suite.
    const { registerRemnawaveWebhookEmitter } = await import('./remnawave.webhook.events.js');
    registerRemnawaveWebhookEmitter();

    const { nodeUsersQueue } = await import('../users/users.queue.js');
    vi.spyOn(nodeUsersQueue, 'addBulk').mockResolvedValue([] as never);
    vi.spyOn(nodeUsersQueue, 'add').mockResolvedValue({} as never);

    const limited = await user({ status: 'limited', expiresInMs: -1 * HOUR });

    await cron.findExpiredUsers();
    // The emitter is fire-and-forget through the bus and a semaphore slot.
    // Generous: the delivery crosses the event bus, a semaphore slot and a DB
    // read, and this box runs the suite alongside qemu guests. A timeout here
    // would be a red run about machine load, not about the wiring.
    await vi.waitFor(() => expect(mine(limited)).toHaveLength(1), { timeout: 15_000 });

    expect(mine(limited)[0]!.name).toBe('user.expired');
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: limited },
      select: { status: true },
    });
    expect(row.status).toBe('expired');
    vi.restoreAllMocks();
  });
});
