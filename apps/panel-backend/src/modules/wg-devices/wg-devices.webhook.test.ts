import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "A wg config that was lying idle has been taken into use", told to the shop.
 *
 * Why this event and no other: every other channel a buyer holds is announced
 * by the APPLICATION, because the application polls the subscription and sends
 * `x-hwid`. wg and AmneziaWG never poll anything - the file is imported once -
 * so without this the buyer's laptop tunnel appears in their device list with
 * nobody ever having been told. And the announcement can only be made HERE,
 * from the node's own per-peer counters: a tunnel has its own keypair, so the
 * fact is measured rather than claimed by the client.
 *
 * Once per KEY. All of a buyer's tunnels are minted the moment they pay and sit
 * on the node whether or not anyone imports them, so "a device connected" is
 * not the event - "a config nobody had used has started being used" is.
 *
 * The properties pinned below are the ones whose failure is quiet: a second
 * message for a device the buyer has had for months (noise they learn to
 * ignore, on the one channel that is supposed to mean something), a message
 * naming a tunnel by a number that means a different tunnel by the time they
 * read it, and a message that never arrives because two nodes' polls both
 * thought the other one would send it.
 */

const SECRET = 'wg-first-use-secret';

/* eslint-disable @typescript-eslint/no-explicit-any */
let prisma: any;
let webhook: any;
let stats: any;
let service: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Bodies the shop would have received, parsed. */
let sent: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

const userIds: string[] = [];
const profileIds: string[] = [];
const groupIds: string[] = [];
let seq = 0;

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_URL'] = 'http://127.0.0.1:9/panel';
  process.env['REMNAWAVE_COMPAT_WEBHOOK_SECRET'] = SECRET;
  prisma = (await import('../../prisma.js')).prisma;
  webhook = await import('../remnawave-compat/remnawave.webhook.js');
  stats = await import('./wg-devices.stats.js');
  service = await import('./wg-devices.service.js');
});

afterAll(async () => {
  if (userIds.length) {
    await prisma.amneziawgPeer.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wgDevice.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  if (profileIds.length) await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
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

async function makeUser(): Promise<string> {
  const { generateUserCredentials } = await import('../../lib/credentials.js');
  seq += 1;
  const creds = generateUserCredentials();
  const row = await prisma.user.create({
    data: {
      username: `wgfirst-${Date.now()}-${seq}`,
      shortId: creds.shortId,
      subscriptionToken: creds.subscriptionToken,
      hysteriaPassword: creds.hysteriaPassword,
      naivePassword: creds.naivePassword,
      xrayUuid: creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey: creds.amneziawgPublicKey,
      email: `wgfirst-${seq}@example.test`,
      telegramId: 5151n,
    },
  });
  userIds.push(row.id);
  return row.id;
}

/**
 * Give a device an address on a profile, optionally one the buyer's squad
 * actually gives them.
 *
 * Both halves matter. The address is what the buyer is told, so the tests that
 * assert on the name allocate one. And peers are allocated for every user of a
 * wg-bearing node whether or not their squad grants the profile, so a device
 * carries addresses from inbounds the buyer will never be offered - `served`
 * is what tells the two apart.
 */
async function giveAddress(
  userId: string,
  deviceId: string,
  ip: string,
  opts: { served?: boolean } = {},
): Promise<void> {
  seq += 1;
  const profile = await prisma.profile.create({
    data: { name: `wgfirst-profile-${Date.now()}-${seq}`, protocol: 'amneziawg', config: {} },
  });
  profileIds.push(profile.id);
  if (opts.served) {
    const group = await prisma.group.create({
      data: { name: `wgfirst-squad-${Date.now()}-${seq}` },
    });
    groupIds.push(group.id);
    await prisma.groupProfile.create({ data: { groupId: group.id, profileId: profile.id } });
    await prisma.groupMember.create({ data: { groupId: group.id, userId } });
  }
  await prisma.amneziawgPeer.create({
    data: { deviceId, profileId: profile.id, userId, ip },
  });
}

/** The shop's own device lookup, transcribed from `hwid_device_webhook.py`. */
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

/** The label the shop composes for the notification text, transcribed from
 *  `HwidDeviceNotificationService._device_label`: model, then platform and
 *  osVersion joined - unless the platform line is already inside the model. */
function shopLabel(device: Record<string, unknown>): string {
  const model = String(device['deviceModel'] ?? '').trim();
  const platformLine = [device['platform'], device['osVersion']]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (model && platformLine && !model.toLowerCase().includes(platformLine.toLowerCase())) {
    return `${model} · ${platformLine}`;
  }
  return model || platformLine;
}

describe('the first use of a wg tunnel is announced', () => {
  it('sends one event the shop can read the tunnel out of, named by its address', async () => {
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);
    await giveAddress(userId, device.id, '10.68.0.28', { served: true });
    // The same tunnel on a profile this buyer's squad does NOT give them. Peers
    // are allocated per node, not per squad, so this is the ordinary shape of a
    // device rather than a contrived one - measured on the live panel, where a
    // `main` buyer's device held four addresses and their config had one.
    await giveAddress(userId, device.id, '10.66.0.64');

    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 1200, bytesOut: 340 }]);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('user_hwid_devices.added');
    expect(sent[0]!.payload.user.uuid).toBe(userId);

    const found = shopFindsDevice(sent[0]!.payload);
    expect(found, 'the shop would find no device in this payload').not.toBeNull();
    // The identifier the shop hands back to the disconnect button - the same
    // string the device list gives it, or the button leads nowhere.
    expect(found!['hwid']).toBe(`wg:${device.id}`);
    // The ADDRESS, not the ordinal: `device=N` renumbers on revocation, so a
    // buyer acting on "Device 3" would disconnect a tunnel they never touched.
    // The address is minted once and never reissued, and it is in the config
    // file they imported.
    expect(shopLabel(found!)).toContain('10.68.0.28');
    expect(shopLabel(found!)).not.toMatch(/#\d/);
    // And NOT the address from an inbound their subscription never offers: the
    // buyer cannot find that one anywhere, so naming the tunnel by it is worse
    // than naming it by a number - a number at least does not look like a fact.
    expect(shopLabel(found!)).not.toContain('10.66.0.64');
    // Its own creation time, not the poll's: the shop's dedupe fingerprint is
    // hwid+createdAt, and a moving timestamp would make every redelivery look
    // like a new device.
    const row = await prisma.wgDevice.findUnique({ where: { id: device.id } });
    expect(found!['createdAt']).toBe(row.createdAt.toISOString());
  });

  it('says nothing on the polls after the first', async () => {
    // The tunnel is in use now; a message every thirty seconds is how a channel
    // that means something becomes a channel nobody reads.
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);

    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 10, bytesOut: 10 }]);
    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 10, bytesOut: 10 }]);
    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 10, bytesOut: 10 }]);
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('says nothing for a tunnel that only sat there', async () => {
    // A peer that exists but is idle reports zeroes every poll. It has not been
    // taken into use, and `lastSeenAt` must stay null for the next real byte to
    // be the first one.
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);

    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 0, bytesOut: 0 }]);
    await settle();

    expect(sent).toHaveLength(0);
    const row = await prisma.wgDevice.findUnique({ where: { id: device.id } });
    expect(row.lastSeenAt).toBeNull();
  });

  it('announces once when two nodes report the same tunnel at the same moment', async () => {
    // This is the ordinary case, not a rare race: a buyer's tunnel exists on
    // every wg-bearing node, and each node polls on its own schedule. Reading
    // "has it been seen?" and writing "it has now" as two steps would let both
    // folds decide they were first - and the buyer would get the same alarm
    // twice, from a system that is asking them to act on it.
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);

    await Promise.all([
      stats.foldDeviceStats([{ userId: device.id, bytesIn: 500, bytesOut: 100 }]),
      stats.foldDeviceStats([{ userId: device.id, bytesIn: 700, bytesOut: 200 }]),
    ]);
    await settle();

    expect(sent).toHaveLength(1);
    // Both polls' bytes are still counted - the claim decides who announces,
    // not whose traffic is billed.
    const row = await prisma.wgDevice.findUnique({ where: { id: device.id } });
    expect(row.bytesIn).toBe(1200n);
    expect(row.bytesOut).toBe(300n);
  });

  it('says nothing about access the buyer already cancelled', async () => {
    // A revoked tunnel can still move bytes until its peer leaves the node.
    // "A new device connected" about a config the buyer disconnected minutes
    // ago reads as "the disconnect did not work".
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);
    await prisma.wgDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });

    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 90, bytesOut: 10 }]);
    await settle();

    expect(sent).toHaveLength(0);
    const row = await prisma.wgDevice.findUnique({ where: { id: device.id } });
    expect(row.bytesIn, 'the traffic is still accounted for').toBe(90n);
  });

  it('names every address the buyer could be holding, not the first one', async () => {
    // One keypair serves every wg profile, and the allocator gives a different
    // host part on each - so the file the buyer imported carries ONE of the
    // tunnel's addresses. Two flavours on one node is the normal case (stock
    // WireGuard and AmneziaWG), and either file has to be recognisable.
    const userId = await makeUser();
    const [device] = await service.ensureDevices(userId, 1);
    await giveAddress(userId, device.id, '10.68.0.51', { served: true });
    await giveAddress(userId, device.id, '10.69.0.51', { served: true });

    await stats.foldDeviceStats([{ userId: device.id, bytesIn: 7, bytesOut: 7 }]);
    await settle();

    const label = shopLabel(shopFindsDevice(sent[0]!.payload)!);
    expect(label).toContain('10.68.0.51');
    expect(label).toContain('10.69.0.51');
  });

  it("announces each of a buyer's tunnels on its own first use", async () => {
    const userId = await makeUser();
    const devices = await service.ensureDevices(userId, 2);
    await giveAddress(userId, devices[0].id, '10.68.0.41', { served: true });
    await giveAddress(userId, devices[1].id, '10.68.0.42', { served: true });

    await stats.foldDeviceStats([{ userId: devices[0].id, bytesIn: 5, bytesOut: 5 }]);
    await settle();
    expect(sent).toHaveLength(1);

    await stats.foldDeviceStats([
      { userId: devices[0].id, bytesIn: 5, bytesOut: 5 },
      { userId: devices[1].id, bytesIn: 5, bytesOut: 5 },
    ]);
    await settle();

    expect(sent).toHaveLength(2);
    const second = shopFindsDevice(sent[1]!.payload)!;
    expect(second['hwid']).toBe(`wg:${devices[1].id}`);
    expect(shopLabel(second)).toContain('10.68.0.42');
  });
});
