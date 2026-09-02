import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * wg tunnels among the buyer's devices (2026-09-02).
 *
 * The shop's device tab is fed by ONE endpoint, and it treats what comes back
 * as opaque: it counts the array for "N of M", renders the text fields, and
 * hands `hwid` straight back when the buyer taps disconnect. So tunnels join
 * that list here, and the shop shows and counts them without a line changing.
 *
 * That count is the point. The device limit is one number and a buyer spends it
 * on whatever they connect; counting only the clients that send `x-hwid` made
 * wg free, which was a bug in the meaning of the limit rather than its
 * arithmetic. These tests pin the three things that can go wrong quietly: what
 * is counted, what is shown, and who is allowed to revoke.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const adminToken = `icp_wgdev_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = () => ({ authorization: `Bearer ${adminToken}` });
const userIds: string[] = [];

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([import('../../app.js'), import('../../prisma.js')]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.createMany({
    data: [{ name: 'wgdev-admin', tokenHash: sha(adminToken), scopes: [] }],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  if (userIds.length) {
    await prisma.wgDevice.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.hwidUserDevice.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(adminToken) } });
  await prisma.appSetting.deleteMany({ where: { key: 'wgShowUnusedTunnels' } });
  await app.close();
});

let seq = 0;

/** Users are made through the facade, not with a raw insert: the row has
 *  required columns this test has no opinion about, and restating them here
 *  would be a second definition of "a user" to drift from the first. */
async function mkUser(): Promise<{ id: string; ref: number }> {
  const res = await app.inject({
    method: 'POST',
    url: `/${PREFIX}/api/users`,
    headers: bearer(),
    payload: { username: `wgdev_${Date.now()}_${seq++}` },
  });
  if (res.statusCode !== 200) throw new Error(`mkUser failed: ${res.statusCode} ${res.body}`);
  const ref = res.json().response.id as number;
  const row = await prisma.user.findFirst({ where: { numericId: BigInt(ref) }, select: { id: true } });
  userIds.push(row.id);
  return { id: row.id, ref };
}

async function mkTunnel(userId: string, opts: { used: boolean; revoked?: boolean }) {
  const n = seq++;
  return prisma.wgDevice.create({
    data: {
      userId,
      privateKey: `priv-${n}`.padEnd(44, 'x'),
      publicKey: `pub-${n}`.padEnd(44, 'x'),
      presharedKey: `psk-${n}`.padEnd(44, 'x'),
      ...(opts.used ? { lastSeenAt: new Date() } : {}),
      ...(opts.revoked ? { revokedAt: new Date() } : {}),
    },
  });
}

/** The setting is read through a TTL cache, so a test that flips it has to
 *  flip it where the cache will see it. Writing the row and letting the cache
 *  expire would make these tests time-dependent; clearing it is exact. */
async function setShowUnused(value: boolean) {
  await prisma.appSetting.upsert({
    where: { key: 'wgShowUnusedTunnels' },
    create: { key: 'wgShowUnusedTunnels', value },
    update: { value },
  });
  const { invalidateSubscriptionSettingsCache } = await import('../settings/settings.service.js');
  invalidateSubscriptionSettingsCache();
}

const listDevices = (ref: string) =>
  app.inject({ method: 'GET', url: `/${PREFIX}/api/hwid/devices/${ref}`, headers: bearer() });

const del = (payload: unknown) =>
  app.inject({ method: 'POST', url: `/${PREFIX}/api/hwid/devices/delete`, headers: bearer(), payload });

describe('wg tunnels are devices too', () => {
  it('a used tunnel is listed and counted alongside the hwid clients', async () => {
    await setShowUnused(false);
    const u = await mkUser();
    await prisma.hwidUserDevice.create({ data: { userId: u.id, hwid: `phone-${u.id}` } });
    await mkTunnel(u.id, { used: true });

    const devices = listDevices(String(u.ref));
    const body = (await devices).json().response.devices as Record<string, unknown>[];
    // Two entries is the whole feature: the shop's "N of M" is the length of
    // this array, so the limit starts meaning every device rather than only
    // the ones that speak the header.
    expect(body).toHaveLength(2);
    const tunnel = body.find((d) => String(d.hwid).startsWith('wg:'));
    expect(tunnel).toBeDefined();
    expect(tunnel!.platform).toBe('WireGuard/AmneziaWG');
    // Left empty deliberately: the shop draws that row under a "User Agent"
    // label, and traffic figures under that label are worse than no row.
    expect(tunnel!.userAgent).toBeNull();
  });

  it('an untouched tunnel is a slot, not a device, until the setting says otherwise', async () => {
    const u = await mkUser();
    await mkTunnel(u.id, { used: false });

    await setShowUnused(false);
    expect((await listDevices(String(u.ref))).json().response.devices).toHaveLength(0);

    await setShowUnused(true);
    expect((await listDevices(String(u.ref))).json().response.devices).toHaveLength(1);
    await setShowUnused(false);
  });

  it('numbering follows the tunnel, not the filter', async () => {
    // Tunnel #2 must stay #2 whether or not #1 has ever been used. Numbering
    // over the filtered set would rename a buyer's tunnels the moment one of
    // them went quiet, and the name is how they tell which config is which.
    await setShowUnused(false);
    const u = await mkUser();
    await mkTunnel(u.id, { used: false });
    await new Promise((r) => setTimeout(r, 5));
    await mkTunnel(u.id, { used: true });

    const body = (await listDevices(String(u.ref))).json().response.devices as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]!.deviceModel).toBe('WireGuard #2');
  });

  it('a revoked tunnel is history and never shows, even with the setting on', async () => {
    await setShowUnused(true);
    const u = await mkUser();
    await mkTunnel(u.id, { used: true, revoked: true });
    expect((await listDevices(String(u.ref))).json().response.devices).toHaveLength(0);
    await setShowUnused(false);
  });
});

describe('disconnecting a tunnel', () => {
  it('revokes it rather than deleting it, and takes it out of the list', async () => {
    await setShowUnused(false);
    const u = await mkUser();
    const t = await mkTunnel(u.id, { used: true });

    const res = await del({ userId: String(u.ref), hwid: `wg:${t.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.deleted).toBe(true);

    // The row survives: it holds the traffic this tunnel did, and deleting it
    // would free the address for the next device allocated - at which point
    // the config just disconnected works again, for somebody else.
    const after = await prisma.wgDevice.findUnique({ where: { id: t.id } });
    expect(after).not.toBeNull();
    expect(after.revokedAt).not.toBeNull();
    expect((await listDevices(String(u.ref))).json().response.devices).toHaveLength(0);
  });

  it('will not revoke a tunnel belonging to someone else', async () => {
    // The id travels through the buyer's own browser, so asking for a stranger's
    // is a request anyone can make. Ownership has to be settled BEFORE the
    // revoke: checking afterwards revokes first and discovers the theft second.
    await setShowUnused(false);
    const owner = await mkUser();
    const attacker = await mkUser();
    const t = await mkTunnel(owner.id, { used: true });

    const res = await del({ userId: String(attacker.ref), hwid: `wg:${t.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.deleted).toBe(false);
    const after = await prisma.wgDevice.findUnique({ where: { id: t.id } });
    expect(after.revokedAt).toBeNull();
  });

  it('still deletes a plain hwid device, unchanged', async () => {
    const u = await mkUser();
    const hwid = `phone-${Date.now()}`;
    await prisma.hwidUserDevice.create({ data: { userId: u.id, hwid } });
    const res = await del({ userId: String(u.ref), hwid });
    expect(res.json().response.deleted).toBe(true);
    expect(await prisma.hwidUserDevice.findFirst({ where: { userId: u.id, hwid } })).toBeNull();
  });
});
