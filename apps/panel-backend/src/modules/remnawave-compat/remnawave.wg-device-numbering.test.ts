import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * The Nth card in the buyer's device list and the Nth download link are the
 * same tunnel.
 *
 * They are decided in two places that know nothing about each other: the shop's
 * device tab is fed by the facade, which lists the buyer's LIVE tunnels oldest
 * first, while `?device=N` is resolved inside the subscription, from the device
 * set `ensureDevices` returns - also live, also oldest first. Two independent
 * orderings that agree today by construction and would agree tomorrow by luck.
 *
 * What a disagreement costs: the buyer sees a device they do not recognise,
 * taps disconnect on it, and cuts off a different tunnel - which they discover
 * when the phone they never touched stops working. Nothing logs an error;
 * both sides did exactly what they were told.
 *
 * Revocation is where an ordering by position gets interesting, so it is tested
 * rather than argued about: both indexes run over the LIVE set, so revoking the
 * second tunnel makes the former third one the second. That is the very reason
 * the tunnel is NAMED by its address rather than by its number - see
 * `wg-devices.presentation` - and the address is what ties the two sides
 * together here.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const facadeToken = `icp_wgnum_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let jwt: string;

const NODE_NAME = 'wgnum-node';
const SUBNET = '10.88.0.0/24';

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod, { cleanDatabase }, { registerAndLogin }] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
    import('../../../tests/helpers/db.js'),
    import('../../../tests/helpers/auth.js'),
  ]);
  prisma = prismaMod.prisma;
  await cleanDatabase();
  app = await buildApp();
  await app.ready();
  jwt = await registerAndLogin(app);
  await prisma.apiToken.createMany({
    data: [{ name: 'wgnum-facade', tokenHash: sha(facadeToken), scopes: [] }],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(facadeToken) } });
  await app.close();
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

const admin = () => ({ authorization: `Bearer ${jwt}` });
const facade = () => ({ authorization: `Bearer ${facadeToken}` });

async function post(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url, headers: admin(), payload });
  if (res.statusCode >= 300) throw new Error(`POST ${url} → ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body);
}

/** The wg tunnels the shop would draw, in the order it would draw them. The
 *  facade speaks the NUMERIC handle outward and refuses a UUID, so that is what
 *  the shop holds and what this passes. */
async function tunnelsInTheList(ref: string): Promise<Record<string, string>[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/${PREFIX}/api/hwid/devices/${ref}`,
    headers: facade(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json().response.devices as Record<string, string>[]).filter((d) =>
    String(d.hwid).startsWith('wg:'),
  );
}

/** The address inside the config `?device=N` hands over. */
async function addressInDownload(token: string, device: number): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/sub/${token}?format=wgconf&proto=amneziawg&node=${NODE_NAME}&device=${device}`,
  });
  expect(res.statusCode, `device=${device} was not served`).toBe(200);
  const address = /^Address\s*=\s*([^/\s]+)/m.exec(res.body)?.[1];
  expect(address, `no Address line in the config for device=${device}`).toBeTruthy();
  return address!;
}

describe('the Nth tunnel is the same tunnel on both sides', () => {
  let userId: string;
  let userRef: string;
  let subToken: string;

  beforeAll(async () => {
    const node = await post('/api/nodes', { name: NODE_NAME, address: '10.0.0.31' });
    const profile = await post('/api/profiles', {
      name: 'wgnum-awg',
      protocol: 'amneziawg',
      config: {
        subnet: SUBNET,
        serverPrivateKey: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
        serverPublicKey: 'BQ6TIcR/TaTqtY4slJvnVj0I95pkC3z7t4HA54i8qVA=',
        obfuscation: {},
      },
    });
    await post('/api/bindings', { profileId: profile.id, nodeId: node.id, port: 51820 });

    const user = await post('/api/users', { username: 'wgnum-buyer' });
    userId = user.id as string;
    subToken = user.subscriptionToken as string;
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { numericId: true },
    });
    userRef = String(row.numericId);

    // Fetching the subscription is what mints the tunnels and allocates their
    // addresses - there is nothing to compare before a buyer has asked once.
    const sub = await app.inject({ method: 'GET', url: `/sub/${subToken}?format=json` });
    expect(sub.statusCode).toBe(200);
    // A tunnel nobody has used is a slot, not a device, and the list hides it
    // by default. These are a buyer who uses all three.
    await prisma.wgDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { lastSeenAt: new Date() },
    });
  });

  it('lists three tunnels, each one the config its own link hands over', async () => {
    const listed = await tunnelsInTheList(userRef);
    expect(listed).toHaveLength(3);
    // The addresses are distinct in the first place - three cards showing one
    // address would satisfy any pairwise check below.
    expect(new Set(listed.map((d) => d.deviceModel)).size).toBe(3);

    for (const [i, card] of listed.entries()) {
      const fromLink = await addressInDownload(subToken, i + 1);
      expect(
        card.deviceModel,
        `card ${i + 1} names a different tunnel than device=${i + 1} downloads`,
      ).toBe(fromLink);
    }
  });

  it('still lines up after the buyer disconnects the middle one', async () => {
    const before = await tunnelsInTheList(userRef);
    const middle = before[1]!;
    const last = before[2]!;

    const del = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/hwid/devices/delete`,
      headers: facade(),
      payload: { userId: userRef, hwid: middle.hwid },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().response.deleted).toBe(true);

    const after = await tunnelsInTheList(userRef);
    expect(after).toHaveLength(2);

    // The renumbering itself, stated rather than assumed: what was the third
    // tunnel is now the second on BOTH sides. This is why the card is named by
    // its address - "Device 3" on the buyer's screen would now be a tunnel
    // they never put there.
    expect(after[1]!.deviceModel).toBe(last.deviceModel);
    for (const [i, card] of after.entries()) {
      expect(card.deviceModel).toBe(await addressInDownload(subToken, i + 1));
    }

    // Position 3 exists again by now, and that is correct rather than a leak:
    // fetching a config tops the buyer back up to their allowed device count,
    // so the download above minted a REPLACEMENT tunnel. What matters is that
    // it is a new tunnel and not the revoked one coming back.
    const replacement = await tunnelsInTheList(userRef);
    const revoked = await prisma.wgDevice.findUnique({
      where: { id: middle.hwid.slice(3) },
    });
    expect(revoked.revokedAt, 'the revoked row survives, holding its traffic').not.toBeNull();
    expect(
      replacement.map((d) => d.hwid),
      'the revoked tunnel must not reappear in the list',
    ).not.toContain(middle.hwid);
  });
});
