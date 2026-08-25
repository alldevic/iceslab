import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `user_hwid_devices.added`: the panel telling the shop a new device appeared,
 * so the shop can tell the user - and offer a device top-up when they are at
 * their limit.
 *
 * Two things about this event make it worth testing at the seam rather than on
 * the emitter alone. The device rides BESIDE the user inside `payload`, because
 * that object is what the shop reads as its event_data and it hunts for the
 * device among that object's own keys; anything put in `meta` (a sibling of
 * `payload`) is invisible to it. And the row is inserted while a per-user
 * advisory lock is held, so where the emission sits relative to the commit is a
 * property worth pinning, not an implementation detail.
 */

const SECRET = 'hwid-webhook-secret';

/* eslint-disable @typescript-eslint/no-explicit-any */
let hwid: any;
let prisma: any;
let webhook: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Bodies the shop would have received, parsed. */
let sent: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Whether the device row was already committed when the POST went out. */
let rowVisibleAtSend: boolean[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_URL'] = 'http://127.0.0.1:9/panel';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_SECRET'] = SECRET;
  hwid = await import('./hwid.service.js');
  webhook = await import('../remnawave-compat/remnawave.webhook.js');
  prisma = (await import('../../prisma.js')).prisma;
});

afterAll(async () => {
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

beforeEach(() => {
  sent = [];
  rowVisibleAtSend = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      // Read the row on a DIFFERENT connection than the one that inserted it.
      // An emission from inside the transaction would find nothing here, which
      // is the only way to observe "after the commit" rather than assume it.
      const device = body.payload?.hwidUserDevice;
      if (device?.hwid) {
        const row = await prisma.hwidUserDevice.findFirst({ where: { hwid: device.hwid } });
        rowVisibleAtSend.push(!!row);
      }
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let the fire-and-forget emitter finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    const depth = webhook.remnaWebhookQueueDepth();
    if (depth.inFlight === 0 && depth.waiting === 0) return;
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
      username: `hwiduser-${Date.now()}-${seq}`,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
      email: `hwiduser-${seq}@example.test`,
      telegramId: 4242n,
    },
  });
  return row.id;
}

/**
 * The shop's own device lookup, transcribed from `hwid_device_webhook.py`
 * (`_DEVICE_KEYS`, then any non-`user` dict carrying an `hwid`).
 *
 * Reimplemented rather than asserted as a key name on purpose: what matters is
 * that the shop can FIND the device in what we send, and a test that checks for
 * our own chosen key confirms our choice instead of their contract.
 */
function shopFindsDevice(payload: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['hwidDevice', 'hwidUserDevice', 'device']) {
    const candidate = payload[key];
    if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>;
  }
  for (const [key, candidate] of Object.entries(payload)) {
    if (key === 'user' || !candidate || typeof candidate !== 'object') continue;
    if ('hwid' in (candidate as object)) return candidate as Record<string, unknown>;
  }
  return null;
}

describe('a new device is announced to the shop', () => {
  it('sends one event the shop can read the device out of', async () => {
    const userId = await makeUser();
    const device = `dev-${Date.now()}-a`;

    const res = await hwid.enforceHwid(userId, device, 5, {
      platform: 'iOS',
      osVersion: '17.4',
      deviceModel: 'iPhone15,2',
    });
    expect(res.status).toBe('allowed');
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('user_hwid_devices.added');
    // The user still travels where every other event puts it.
    expect(sent[0]!.payload.user.uuid).toBe(userId);

    const found = shopFindsDevice(sent[0]!.payload);
    expect(found, 'the shop would find no device in this payload').not.toBeNull();
    expect(found!['hwid']).toBe(device);
    expect(found!['platform']).toBe('iOS');
    expect(found!['deviceModel']).toBe('iPhone15,2');
  });

  it('carries the timestamp the shop dedupes on, under the name it reads', async () => {
    // The shop fingerprints `hwid + createdAt` so that a device removed and
    // reconnected reads as a NEW event rather than a duplicate delivery to
    // swallow. Our column is `firstSeenAt`; sent under that name the field is
    // simply absent there, every event for one HWID collapses onto a single
    // fingerprint, and the second connection is never announced.
    const userId = await makeUser();
    await hwid.enforceHwid(userId, `dev-${Date.now()}-ts`, 5, { platform: 'macOS' });
    await settle();

    const found = shopFindsDevice(sent[0]!.payload)!;
    expect(found['createdAt']).toBeTruthy();
    expect(new Date(String(found['createdAt'])).getTime()).not.toBeNaN();
  });

  it('does not leak the fields the shop refuses to handle', async () => {
    // `hwid_device_webhook.py` says raw request IP and user-agent are kept out
    // of its queue payloads, logs and notifications. Sending them anyway would
    // widen where they travel for no consumer at all.
    const userId = await makeUser();
    await hwid.enforceHwid(userId, `dev-${Date.now()}-pii`, 5, {
      platform: 'Windows',
      userAgent: 'Mozilla/5.0 (secret-agent)',
    });
    await settle();

    const raw = JSON.stringify(sent[0]);
    expect(raw).not.toContain('secret-agent');
    expect(raw).not.toContain('userAgent');
  });

  it('fires only after the row is committed', async () => {
    // The insert holds a per-user advisory lock until the transaction ends. An
    // emission from inside it would POST to a third party with that lock held,
    // stalling every other device check for the user for a network round trip.
    const userId = await makeUser();
    await hwid.enforceHwid(userId, `dev-${Date.now()}-commit`, 5, {});
    await settle();

    expect(rowVisibleAtSend, 'the webhook went out before the insert committed').toEqual([true]);
  });

  it('says nothing when a device it already knows checks in again', async () => {
    // The fast path is a lastSeenAt touch on every request. Announcing "new
    // device" there would mean a notification per request from a device the
    // user has always had.
    const userId = await makeUser();
    const device = `dev-${Date.now()}-repeat`;
    await hwid.enforceHwid(userId, device, 5, {});
    await settle();
    expect(sent).toHaveLength(1);

    await hwid.enforceHwid(userId, device, 5, {});
    await hwid.enforceHwid(userId, device, 5, {});
    await settle();
    expect(sent, 'a known device announced itself again').toHaveLength(1);
  });

  it('says nothing when the device is refused at the limit', async () => {
    // No row was created, so there is no device to announce - and announcing
    // one would tell the user a device connected at the exact moment it did not.
    const userId = await makeUser();
    await hwid.enforceHwid(userId, `dev-${Date.now()}-one`, 1, {});
    await settle();
    expect(sent).toHaveLength(1);

    const denied = await hwid.enforceHwid(userId, `dev-${Date.now()}-two`, 1, {});
    expect(denied.status).toBe('denied');
    await settle();
    expect(sent, 'a refused device was announced as connected').toHaveLength(1);
  });
});
