import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Live-risk (2) from docs/remnawave-compat.md §14: the mass-expiry burst.
 *
 * One expiry tick flips every user whose term ended since the last one, and at
 * a month boundary that is the whole cohort. Each flip emits `user.expired`,
 * and each emission reads a row and POSTs to the shop. Before the semaphore
 * those all started at once: thousands of Prisma checkouts against a pool of a
 * dozen, and a burst of that width at a shop sized for a trickle. There is no
 * retry behind `user.expired` - what the stampede drops is gone.
 *
 * The measurement is the point: this counts what is actually in flight, so it
 * fails if the bound is removed rather than asserting that a bound exists.
 */

const LIMIT = 4;
const SECRET = 'burst-secret';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webhook: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

let inFlight = 0;
let peak = 0;
let delivered: string[] = [];
let release: (() => void)[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_URL'] = 'http://127.0.0.1:9/panel';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_SECRET'] = SECRET;
  process.env['REMNAWAVE_COMPAT_WEBHOOK_CONCURRENCY'] = String(LIMIT);
  webhook = await import('./remnawave.webhook.js');
  prisma = (await import('../../prisma.js')).prisma;
});

afterAll(async () => {
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

beforeEach(() => {
  inFlight = 0;
  peak = 0;
  delivered = [];
  release = [];
  // A send that only completes when this test lets it: without a held request
  // the pool never fills and the peak is 1 no matter what the bound is, so the
  // test would pass with the semaphore deleted.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      delivered.push(JSON.parse(init.body).payload.user.uuid);
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let everything that is currently held finish, repeatedly, until the queue is empty. */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const held = release.splice(0, release.length);
    held.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 5));
    const depth = webhook.remnaWebhookQueueDepth();
    if (depth.inFlight === 0 && depth.waiting === 0 && release.length === 0) return;
  }
  throw new Error('the webhook queue never drained');
}

let seq = 0;
async function makeUser(): Promise<string> {
  const { generateUserCredentials } = await import('../../lib/credentials.js');
  seq += 1;
  const creds = generateUserCredentials();
  const row = await prisma.user.create({
    data: {
      username: `burst-${Date.now()}-${seq}`,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
      email: `burst-${seq}@example.test`,
      expireAt: new Date(Date.now() - 1000),
    },
  });
  return row.id;
}

describe('the facade webhook emitter under a mass-expiry burst', () => {
  it('never has more sends in flight than the configured limit, and loses none', async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMIT * 5; i += 1) ids.push(await makeUser());

    // Exactly what findExpiredUsers' event handler does, once per flipped user,
    // with nothing between them.
    for (const id of ids) webhook.emitRemnaWebhookForUser('user.expired', id);

    // Give the first wave time to reach fetch before measuring.
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBeLessThanOrEqual(LIMIT);
    expect(peak).toBe(LIMIT); // and it does use the slots it is given

    await drain();

    expect(delivered.length).toBe(ids.length);
    expect([...delivered].sort()).toEqual([...ids].sort());
    expect(peak).toBeLessThanOrEqual(LIMIT);

    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('does not hold a database connection for a user that is still queued', async () => {
    // The row is read INSIDE the slot. A handler that read it first would have
    // one Prisma checkout per user outstanding before the semaphore ever saw
    // them - the pool exhaustion the bound is meant to prevent, reintroduced by
    // where the read happens.
    const ids: string[] = [];
    for (let i = 0; i < LIMIT * 3; i += 1) ids.push(await makeUser());

    const findUnique = vi.spyOn(prisma.user, 'findUnique');
    for (const id of ids) webhook.emitRemnaWebhookForUser('user.expired', id);
    await new Promise((r) => setTimeout(r, 20));

    // Only the running slots have looked anything up.
    expect(findUnique.mock.calls.length).toBeLessThanOrEqual(LIMIT);

    await drain();
    expect(findUnique.mock.calls.length).toBe(ids.length);
    findUnique.mockRestore();

    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('frees the slot when the user is gone, instead of wedging the queue', async () => {
    const alive = await makeUser();
    const ghost = '00000000-0000-4000-8000-0000000000ff';

    for (let i = 0; i < LIMIT; i += 1) webhook.emitRemnaWebhookForUser('user.expired', ghost);
    webhook.emitRemnaWebhookForUser('user.expired', alive);

    await drain();

    // The four lookups that found nothing sent nothing and, crucially, let the
    // fifth through.
    expect(delivered).toEqual([alive]);
    expect(webhook.remnaWebhookQueueDepth()).toEqual({ inFlight: 0, waiting: 0 });

    await prisma.user.deleteMany({ where: { id: alive } });
  });
});
