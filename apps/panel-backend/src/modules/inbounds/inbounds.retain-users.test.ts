import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RetainUsersRequest } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { NodeTransport, NodeRequestError } from '../nodes/nodes.transport.js';
import { applyInboundsForNode, fetchEnabledInbounds } from './inbounds.queue.js';

/**
 * The user push only ever ADDS, so the node has to be told what the whole set is.
 *
 * `addUser` is dispatched one record at a time and `removeUser` reaches only the
 * ids the panel remembers to name — and an adapter answers `ok` for an id it does
 * not hold, so nothing said otherwise. For the wg family the consequence is not a
 * stale row: a peer IS the access, so a device deleted while its node was
 * unreachable kept a working tunnel until someone ran `awg-quick down` by hand.
 *
 * What is asserted here is the panel's half: every sync states the complete set,
 * and an agent too old to have the endpoint does not fail the sync.
 */

let seq = 0;

async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:8443`,
      status: 'online',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return row.id;
}

async function boundProfile(nodeId: string, protocol: string, port: number): Promise<string> {
  seq += 1;
  const profile = await prisma.profile.create({
    data: { name: `p-${protocol}-${seq}`, protocol, config: {}, enabled: true },
  });
  await prisma.profileNodeBinding.create({
    data: { profileId: profile.id, nodeId, port, enabled: true },
  });
  return profile.id;
}

/** Through the API, so the user is minted exactly as a real one is - every
 *  derived credential in place. */
async function user(name: string): Promise<string> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { authorization: `Bearer ${token}` },
    payload: { username: `${name}-${seq}` },
  });
  if (res.statusCode !== 201) throw new Error(`createUser failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

/** Stub the whole wire, so nothing here needs a node to answer. */
function stubTransport(retain?: () => Promise<never>) {
  vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({
    ok: true,
    applied: 1,
    skipped: 0,
  });
  vi.spyOn(NodeTransport.prototype, 'addUser').mockResolvedValue(undefined);
  const retainSpy = vi.spyOn(NodeTransport.prototype, 'retainUsers');
  if (retain) {
    retainSpy.mockImplementation(retain);
  } else {
    retainSpy.mockResolvedValue({ ok: true, reconciled: ['amneziawg|amneziawg'] });
  }
  return retainSpy;
}

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('every inbound sync states the node’s whole user set', () => {
  it('names every active user it just pushed', async () => {
    const nodeId = await node('retain');
    await boundProfile(nodeId, 'xray', 443);
    const alice = await user('alice');
    const bob = await user('bob');
    const retain = stubTransport();

    await applyInboundsForNode(nodeId);

    expect(retain).toHaveBeenCalledTimes(1);
    const sent = retain.mock.calls[0]![0] as RetainUsersRequest;
    expect([...sent.userIds].sort()).toEqual([alice, bob].sort());
  });

  it('leaves out a user the panel no longer serves, which is the whole point', async () => {
    // The control: the keep set has to be a statement about NOW. A set that
    // happened to contain everyone who ever existed would reconcile nothing.
    const nodeId = await node('retain-drop');
    await boundProfile(nodeId, 'xray', 443);
    const alice = await user('alice');
    const gone = await user('gone');
    await prisma.user.update({ where: { id: gone }, data: { status: 'disabled' } });
    const retain = stubTransport();

    await applyInboundsForNode(nodeId);

    const sent = retain.mock.calls[0]![0] as RetainUsersRequest;
    expect(sent.userIds).toEqual([alice]);
  });

  it('keeps a device whose address allocation failed this round', async () => {
    // The keep set is what the panel BELIEVES belongs here, not what the fan-out
    // delivered. A device with no allocated address is skipped by the push - and
    // if that skip also dropped it from the keep set, one transient allocator
    // failure would revoke a working tunnel on the node.
    const nodeId = await node('retain-alloc');
    const profileId = await boundProfile(nodeId, 'amneziawg', 1234);
    const alice = await user('alice');
    const device = await prisma.wgDevice.create({
      data: {
        userId: alice,
        label: 'phone',
        publicKey: 'pub-key-of-a-phone',
        privateKey: 'priv',
        presharedKey: null,
      },
    });
    const retain = stubTransport();
    // No address is allocated for it on this profile, so the push skips it.
    expect(
      await prisma.amneziawgPeer.findFirst({ where: { deviceId: device.id, profileId } }),
    ).toBeNull();

    await applyInboundsForNode(nodeId);

    const sent = retain.mock.calls[0]![0] as RetainUsersRequest;
    expect(sent.userIds).toContain(device.id);
  });

  it('drops a buyer deleted while this very push was in flight', async () => {
    // Гонка, которая отказывает молча. Синк читает пользователей ДО коммита
    // удаления, а дописывает пиров ПОСЛЕ того, как их сняли: `removeUser`
    // отработал по старому набору, а этот прогон вернул человека обратно и
    // назвал его в наборе для сверки. `addUser` на wg-адаптере отвечает `ok`
    // в обоих случаях, так что в логе это выглядит как обычный успешный синк.
    //
    // Набор для сверки перечитывается перед самой отправкой, поэтому тот же
    // прогон, который человека вернул, его и снимает. Раньше это ложилось на
    // СЛЕДУЮЩИЙ синк, какой бы ни случился, и до него удалённый покупатель
    // продолжал ходить.
    const nodeId = await node('retain-race');
    await boundProfile(nodeId, 'amneziawg', 1234);
    const alice = await user('alice');
    const gone = await user('gone');
    const retain = stubTransport();
    // Удаление приходит в середине раздачи: набор уже прочитан, устройства уже
    // заведены, пиры уже уезжают на ноду.
    vi.spyOn(NodeTransport.prototype, 'addUser').mockImplementation(async () => {
      await prisma.user.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    });

    await applyInboundsForNode(nodeId);

    const sent = retain.mock.calls[0]![0] as RetainUsersRequest;
    expect(sent.userIds).toContain(alice);
    expect(sent.userIds).not.toContain(gone);
    // И устройства тоже: пир — это и есть доступ, а заведён он под id
    // УСТРОЙСТВА, так что набор, назвавший их, оставил бы туннель живым.
    const devices = await prisma.wgDevice.findMany({
      where: { userId: gone },
      select: { id: true },
    });
    // Control: у удалённого устройства действительно были, иначе проверка ниже
    // не проверяет ничего.
    expect(devices.length).toBeGreaterThan(0);
    for (const d of devices) expect(sent.userIds).not.toContain(d.id);
    // А у живого — остались.
    const aliceDevices = await prisma.wgDevice.findMany({
      where: { userId: alice },
      select: { id: true },
    });
    for (const d of aliceDevices) expect(sent.userIds).toContain(d.id);
  });

  it('does not fail the sync on an agent that has no such endpoint', async () => {
    // A node mid-upgrade answers 404. The inbounds and users that landed are
    // live, and failing the job would retry a push that already worked.
    const nodeId = await node('retain-old');
    await boundProfile(nodeId, 'xray', 443);
    await user('alice');
    stubTransport(async () => {
      throw new NodeRequestError('not found', 404, null);
    });

    await expect(applyInboundsForNode(nodeId)).resolves.toBeUndefined();
  });
});

describe('a wg key travels only with its address', () => {
  it('omits the flavour the node has no profile for', async () => {
    // A node can run both wg adapters with only one flavour bound. Sending the
    // device's key for the unbound one used to be inert - the adapter dropped a
    // peer with no address and answered ok. Now it refuses, correctly, so the
    // panel must stop sending what it knows cannot be made.
    const nodeId = await node('awg-only');
    await boundProfile(nodeId, 'amneziawg', 1234);
    const alice = await user('alice');
    await prisma.wgDevice.create({
      data: {
        userId: alice,
        label: 'phone',
        publicKey: 'pub-key-of-a-phone',
        privateKey: 'priv',
        presharedKey: null,
      },
    });
    vi.spyOn(NodeTransport.prototype, 'applyInbounds').mockResolvedValue({
      ok: true,
      applied: 1,
      skipped: 0,
    });
    vi.spyOn(NodeTransport.prototype, 'retainUsers').mockResolvedValue({ ok: true, reconciled: [] });
    const addUser = vi.spyOn(NodeTransport.prototype, 'addUser').mockResolvedValue(undefined);

    await applyInboundsForNode(nodeId);

    const device = addUser.mock.calls.map(([r]) => r).find((r) => r.userId !== alice);
    expect(device, 'the device was not pushed at all').toBeDefined();
    expect(device!.credentials.amneziawgPublicKey).toBe('pub-key-of-a-phone');
    expect(device!.credentials.amneziawgAllowedIp).toBeTruthy();
    expect(
      device!.credentials.wireguardPublicKey,
      'a key was sent for a flavour with no address, which the node now refuses',
    ).toBeUndefined();
  });
});

describe('the wg push says which inbound it is', () => {
  it('carries the binding id, which is what a removal is later matched against', async () => {
    // The adapter holds ONE inbound and applyInbounds is dispatched one at a
    // time, so an inbound that vanished from the set produces no call at all.
    // Without an id to compare, the interface, its peers and its port outlived
    // the binding forever - measured 2026-08-31, both wg bindings disabled and
    // both interfaces still up.
    const nodeId = await node('wg-wire');
    await boundProfile(nodeId, 'amneziawg', 1234);
    await boundProfile(nodeId, 'wireguard', 51820);

    const inbounds = await fetchEnabledInbounds(nodeId);
    expect(inbounds).toHaveLength(2);
    for (const ib of inbounds) {
      const cfg = ib.config as { inboundId?: string; listenPort?: number };
      expect(cfg.inboundId, `${ib.protocol} carries no inbound id`).toBe(ib.id);
      expect(cfg.listenPort).toBe(ib.port);
    }
  });
});
