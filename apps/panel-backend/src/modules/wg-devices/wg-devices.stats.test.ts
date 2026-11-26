import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GetStatsResponse } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { pollNodeStats } from '../stats/stats.cron.js';
import { creditDeviceTraffic } from './wg-devices.stats.js';
import { ensureDevices } from './wg-devices.service.js';

// Per-device counters (milestone 9.6): the node reports a peer's bytes and
// latest handshake by public key, the panel writes them to wg_devices by key.

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function create(url: string, payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url, headers: auth(), payload });
  if (res.statusCode !== 201) throw new Error(`${url} failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body).id as string;
}

type Peer = { publicKey: string; bytesIn: number; bytesOut: number; lastHandshake?: number };
const poll = (users: { userId: string; bytesIn: number; bytesOut: number; cumulative?: boolean; peers?: Peer[] }[]): GetStatsResponse =>
  ({ users, uptime: 1, totalBytesIn: 0, totalBytesOut: 0 }) as GetStatsResponse;
const answer = (byAddress: Record<string, GetStatsResponse>) =>
  vi.spyOn(NodeTransport.prototype, 'getStats').mockImplementation(async function (this: unknown) {
    const addr = (this as { node: { address: string } }).node.address;
    return byAddress[addr]!;
  });

describe('device traffic from the poll', () => {
  it('credits two devices of one user on two nodes by key, adds across polls, and reads the handshake', async () => {
    await create('/api/nodes', { name: 'n1', address: '10.0.0.1:8443' });
    await create('/api/nodes', { name: 'n2', address: '10.0.0.2:8443' });
    const userId = await create('/api/users', { username: 'dev_user' });
    const { devices } = await ensureDevices(userId, 2);
    const [d1, d2] = devices as [typeof devices[0], typeof devices[0]];
    const hs1 = 1_900_000_000 - 100;
    const hs2 = 1_900_000_000 - 50;

    vi.useFakeTimers({ toFake: ['Date'], now: new Date(1_900_000_000 * 1000) });
    try {
      answer({
        '10.0.0.1:8443': poll([{ userId, bytesIn: 150, bytesOut: 60, peers: [
          { publicKey: d1.publicKey, bytesIn: 100, bytesOut: 50, lastHandshake: hs1 },
          { publicKey: d2.publicKey, bytesIn: 50, bytesOut: 10, lastHandshake: hs2 },
        ] }]),
        '10.0.0.2:8443': poll([{ userId, bytesIn: 7, bytesOut: 3, peers: [
          // The same device on the second node, and a key nobody issued.
          { publicKey: d1.publicKey, bytesIn: 5, bytesOut: 2, lastHandshake: hs1 - 10 },
          { publicKey: 'unknown-key-unknown-key-unknown-key-unknown=', bytesIn: 2, bytesOut: 1, lastHandshake: hs1 },
        ] }]),
      });
      const r = await pollNodeStats();
      expect(r.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    let a = await prisma.wgDevice.findUniqueOrThrow({ where: { id: d1.id } });
    let b = await prisma.wgDevice.findUniqueOrThrow({ where: { id: d2.id } });
    expect([a.bytesIn, a.bytesOut]).toEqual([105n, 52n]);
    expect([b.bytesIn, b.bytesOut]).toEqual([50n, 10n]);
    expect(a.lastSeenAt?.getTime()).toBe(hs1 * 1000); // the later of the two nodes' handshakes
    expect(b.lastSeenAt?.getTime()).toBe(hs2 * 1000);
    // The user's own accounting is what it was: the sum of the entries.
    const t = await prisma.userTraffic.findUniqueOrThrow({ where: { userId } });
    expect(t.usedTrafficBytes).toBe(150n + 60n + 7n + 3n);

    // A second poll: the interface was recreated on node 1 (the agent restarts
    // the delta from the counter: small numbers), the handshake is gone (0).
    vi.restoreAllMocks();
    answer({
      '10.0.0.1:8443': poll([{ userId, bytesIn: 4, bytesOut: 1, peers: [{ publicKey: d1.publicKey, bytesIn: 4, bytesOut: 1 }] }]),
      '10.0.0.2:8443': poll([]),
    });
    await pollNodeStats();
    a = await prisma.wgDevice.findUniqueOrThrow({ where: { id: d1.id } });
    b = await prisma.wgDevice.findUniqueOrThrow({ where: { id: d2.id } });
    expect([a.bytesIn, a.bytesOut]).toEqual([109n, 53n]);
    expect(a.lastSeenAt?.getTime()).toBe(hs1 * 1000); // not moved back
    expect(b.bytesIn).toBe(50n);
  });

  it('an agent without a peer list (old) does not break the poll, and a cumulative entry is not credited', async () => {
    await create('/api/nodes', { name: 'old', address: '10.0.0.3:8443' });
    const userId = await create('/api/users', { username: 'old_agent' });
    const { devices } = await ensureDevices(userId, 1);
    answer({
      '10.0.0.3:8443': poll([
        { userId, bytesIn: 9, bytesOut: 9 },
        { userId, bytesIn: 1000, bytesOut: 1000, cumulative: true, peers: [{ publicKey: devices[0]!.publicKey, bytesIn: 1000, bytesOut: 1000 }] },
      ]),
    });
    const r = await pollNodeStats();
    expect(r).toEqual({ ok: 1, failed: 0 });
    const d = await prisma.wgDevice.findUniqueOrThrow({ where: { id: devices[0]!.id } });
    expect([d.bytesIn, d.bytesOut, d.lastSeenAt]).toEqual([0n, 0n, null]);
  });

  it('does not credit a revoked device', async () => {
    const userId = await create('/api/users', { username: 'revoked_dev' });
    const { devices } = await ensureDevices(userId, 2);
    await prisma.wgDevice.update({ where: { id: devices[0]!.id }, data: { revokedAt: new Date() } });
    const n = await creditDeviceTraffic(
      [{ userId, peers: devices.map((d) => ({ publicKey: d.publicKey, bytesIn: 10, bytesOut: 10, lastHandshake: 5 })) }],
      new Date(),
    );
    expect(n).toBe(1);
    const rows = await prisma.wgDevice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    expect(rows[0]!.bytesIn).toBe(0n);
    expect(rows[1]!.bytesIn).toBe(10n);
  });
});
