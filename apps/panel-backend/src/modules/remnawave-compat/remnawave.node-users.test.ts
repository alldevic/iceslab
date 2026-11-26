import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * GET /bandwidth-stats/nodes/{uuid}/users ranks and cuts on the number it
 * reports (in + out). It used to order and `take` in SQL on bytesIn alone, so
 * past the limit a user heavy outbound was dropped for a lighter total, and the
 * shop's premium billing read that user as zero.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const token = `icp_nodeusers_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = { authorization: `Bearer ${token}` };

const userIds: string[] = [];
const nodeIds: string[] = [];
let seq = 0;

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = PREFIX;
  const [{ buildApp }, prismaMod] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.create({ data: { name: 'node-users', tokenHash: sha(token), scopes: [] } });
});

afterAll(async () => {
  await prisma.nodeUserUsageHistory.deleteMany({ where: { nodeId: { in: nodeIds } } });
  await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userTraffic.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(token) } });
  await app.close();
});

async function mkUser(): Promise<{ id: string }> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: `/${PREFIX}/api/users`,
    headers: bearer,
    payload: { username: `nu_${Date.now()}_${seq}` },
  });
  const row = await prisma.user.findFirst({
    where: { numericId: BigInt(res.json().response.id) },
    select: { id: true },
  });
  userIds.push(row.id);
  return { id: row.id };
}

async function mkNode(): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `nu-node-${Date.now()}-${seq}`,
      address: `nu-${Date.now()}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  nodeIds.push(n.id);
  return n.id as string;
}

async function usage(nodeId: string, userId: string, bytesIn: number, bytesOut: number, day = '2026-08-10') {
  await prisma.nodeUserUsageHistory.create({
    data: { nodeId, userId, date: new Date(`${day}T00:00:00.000Z`), bytesIn, bytesOut },
  });
}

type Top = { user: { uuid: string; username: string | null }; total: number }[];

describe('GET /bandwidth-stats/nodes/{uuid}/users', () => {
  it('ranks and cuts on in + out, not on one direction', async () => {
    const n = await mkNode();
    const out = await mkUser(); // 50 in + 500 out = 550
    const inb = await mkUser(); // 400 in + 0 out = 400
    await usage(n, out.id, 50, 500);
    await usage(n, inb.id, 400, 0);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/${n}/users?topUsersLimit=1`,
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    const top = res.json().response.topUsers as Top;
    // Cut on bytesIn, `inb` would survive and the bigger user would be dropped.
    expect(top).toHaveLength(1);
    expect(top[0]!.user.uuid).toBe(out.id);
    expect(top[0]!.total).toBe(550);
  });

  it('orders the whole list by the total, summing across days, and names the users', async () => {
    const n = await mkNode();
    const spread = await mkUser(); // 100 + 100 over two days, 300 out: 500
    const outHeavy = await mkUser(); // 0 in, 450 out: 450
    const single = await mkUser(); // 400 in, 0 out: 400
    await usage(n, spread.id, 100, 150, '2026-08-10');
    await usage(n, spread.id, 100, 150, '2026-08-11');
    await usage(n, outHeavy.id, 0, 450);
    await usage(n, single.id, 400, 0);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/${n}/users`,
      headers: bearer,
    });
    const top = res.json().response.topUsers as Top;
    expect(top.map((t) => [t.user.uuid, t.total])).toEqual([
      [spread.id, 500],
      [outHeavy.id, 450],
      [single.id, 400],
    ]);
    expect(top[0]!.user.username).toMatch(/^nu_/);
  });
});
