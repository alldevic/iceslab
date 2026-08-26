import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * The four capability routes served on 2026-08-24, and specifically the parts of
 * their contracts that fail SILENTLY when wrong.
 *
 * They were unserved while the shop could not certify our declared version - it
 * never called them. Its `dev` branch certifies 3.3.2, so it will; and because
 * the shop's admin panel is our admin panel, each of these is an admin feature
 * rather than spare surface.
 *
 * Every case here corresponds to a line in the shop's own client that turns a
 * wrong answer into a fallback or a mis-billing instead of an error.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const token = `icp_admin_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = { authorization: `Bearer ${token}` };

const userIds: string[] = [];
const nodeIds: string[] = [];
const squadIds: string[] = [];
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
  await prisma.apiToken.create({ data: { name: 'admin-routes', tokenHash: sha(token), scopes: [] } });
});

afterAll(async () => {
  await prisma.nodeUserUsageHistory.deleteMany({ where: { nodeId: { in: nodeIds } } });
  await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userTraffic.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
  await prisma.group.deleteMany({ where: { id: { in: squadIds } } });
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(token) } });
  await app.close();
});

const post = (url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/${PREFIX}/api/${url}`, headers: bearer, payload: payload ?? {} });

async function mkUser(): Promise<{ id: string; numericId: number; username: string }> {
  seq += 1;
  const res = await post('users', { username: `adm_${Date.now()}_${seq}` });
  const body = res.json().response as { id: number; username: string };
  const row = await prisma.user.findFirst({ where: { numericId: BigInt(body.id) }, select: { id: true } });
  userIds.push(row.id);
  return { id: row.id, numericId: body.id, username: body.username };
}

async function mkNode(): Promise<string> {
  seq += 1;
  const n = await prisma.node.create({
    data: {
      name: `adm-node-${Date.now()}-${seq}`,
      address: `adm-${Date.now()}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  nodeIds.push(n.id);
  return n.id as string;
}

async function mkSquad(): Promise<string> {
  seq += 1;
  const g = await prisma.group.create({ data: { name: `adm-squad-${Date.now()}-${seq}` } });
  squadIds.push(g.id);
  return g.id as string;
}

async function usage(nodeId: string, userId: string, bytesIn: number, bytesOut = 0) {
  await prisma.nodeUserUsageHistory.create({
    data: { nodeId, userId, date: new Date('2026-08-10T00:00:00.000Z'), bytesIn, bytesOut },
  });
}

describe('POST /users/bulk/update-squads', () => {
  it('reports the count under `affectedRows`, which is the key the client reads', async () => {
    const u = await mkUser();
    const squad = await mkSquad();
    const res = await post('users/bulk/update-squads', {
      userIds: [u.numericId],
      activeInternalSquads: [squad],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().response as Record<string, unknown>;
    // Our other bulk routes answer `affected`. This one must not: the client
    // reads `.get("affectedRows")` and only compares when it is an int, so the
    // wrong key yields None, no complaint, and a bulk it believes worked.
    expect(Object.keys(body)).toContain('affectedRows');
    expect(body.affectedRows).toBe(1);
  });

  it('sets the exact squad set, replacing what was there', async () => {
    const u = await mkUser();
    const [a, b] = [await mkSquad(), await mkSquad()];
    await post('users/bulk/update-squads', { userIds: [u.numericId], activeInternalSquads: [a] });
    await post('users/bulk/update-squads', { userIds: [u.numericId], activeInternalSquads: [b] });
    const got = await prisma.groupMember.findMany({
      where: { userId: u.id },
      select: { groupId: true },
    });
    expect(got.map((g: { groupId: string }) => g.groupId)).toEqual([b]);
  });

  it('counts a user ALREADY in the requested state', async () => {
    // The client treats `affectedRows < len(chunk)` as failure and falls back to
    // per-user PATCH for the whole chunk. Counting writes instead of matches
    // would report failure exactly when the bulk had least to do - the common
    // case on a re-run.
    const u = await mkUser();
    const squad = await mkSquad();
    const first = await post('users/bulk/update-squads', {
      userIds: [u.numericId],
      activeInternalSquads: [squad],
    });
    const again = await post('users/bulk/update-squads', {
      userIds: [u.numericId],
      activeInternalSquads: [squad],
    });
    expect(first.json().response.affectedRows).toBe(1);
    expect(again.json().response.affectedRows).toBe(1);
  });

  it('skips a reference this panel never issued instead of abandoning the chunk', async () => {
    const u = await mkUser();
    const squad = await mkSquad();
    const res = await post('users/bulk/update-squads', {
      userIds: [999_000_111, u.numericId],
      activeInternalSquads: [squad],
    });
    expect(res.statusCode).toBe(200);
    // One of two: the real user was still processed.
    expect(res.json().response.affectedRows).toBe(1);
  });
});

describe('POST /bandwidth-stats/nodes/usage', () => {
  it('answers for EVERY requested node, including ones with no traffic', async () => {
    // The client pre-seeds a zero lookup per requested node and overwrites from
    // the response, so a node we omit reads as "no traffic" rather than
    // "unknown" - silently, in the path that bills premium tariffs.
    const [n1, n2] = [await mkNode(), await mkNode()];
    const u = await mkUser();
    await usage(n1, u.id, 100, 50);
    const res = await post('bandwidth-stats/nodes/usage', { nodesUuids: [n1, n2] });
    expect(res.statusCode).toBe(200);
    const nodes = res.json().response.nodes as { uuid: string; users: unknown[] }[];
    expect(nodes.map((n) => n.uuid).sort()).toEqual([n1, n2].sort());
    expect(nodes.find((n) => n.uuid === n2)!.users).toEqual([]);
  });

  it('keys users by the NUMERIC id and totals both directions', async () => {
    const n = await mkNode();
    const u = await mkUser();
    await usage(n, u.id, 700, 300);
    const res = await post('bandwidth-stats/nodes/usage', { nodesUuids: [n] });
    const users = res.json().response.nodes[0].users as { id: number; totalBytes: number }[];
    // rw3 identity: the shop keys usage by String(id), so a uuid here would
    // build a bucket no user matches and the bytes would go unattributed.
    expect(users).toEqual([{ id: u.numericId, uuid: u.id, username: u.username, totalBytes: 1000 }]);
  });

  it('honours minTotalBytes', async () => {
    const n = await mkNode();
    const small = await mkUser();
    const big = await mkUser();
    await usage(n, small.id, 10);
    await usage(n, big.id, 5000);
    const res = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/usage?minTotalBytes=1000`,
      headers: bearer,
      payload: { nodesUuids: [n] },
    });
    const users = res.json().response.nodes[0].users as { id: number }[];
    expect(users.map((x) => x.id)).toEqual([big.numericId]);
  });

  it('an empty node set is an empty answer, not a 400', async () => {
    const res = await post('bandwidth-stats/nodes/usage', { nodesUuids: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.nodes).toEqual([]);
  });
});

describe('POST /bandwidth-stats/nodes/users', () => {
  it('merges one user across nodes into a single row', async () => {
    const [n1, n2] = [await mkNode(), await mkNode()];
    const u = await mkUser();
    await usage(n1, u.id, 400);
    await usage(n2, u.id, 600);
    const res = await post('bandwidth-stats/nodes/users', { nodesUuids: [n1, n2] });
    const top = res.json().response.topUsers as { user: { uuid: string }; total: number }[];
    const mine = top.filter((t) => t.user.uuid === u.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].total).toBe(1000);
  });

  it('ranks on the merged total, so the limit cuts the right users', async () => {
    // The traffic is deliberately LOPSIDED between the two directions. The
    // earlier version of this test gave every user its bytes through `usage`'s
    // bytesIn and left bytesOut at its default zero - so "rank by one column"
    // and "rank by the merged total" were the same number, and the test could
    // not tell them apart. Mutation-checked: ordering the groupBy by
    // `_sum.bytesIn` and deleting the sort below passed it.
    //
    // Now each candidate wins under exactly one wrong rule and loses under the
    // right one, so ranking by bytesIn alone, by bytesOut alone, or ascending
    // each picks a different top user:
    //
    //            bytesIn   bytesOut   total
    //   spread       100        500     600   <- correct winner
    //   outHeavy       0        550     550   <- wins on bytesOut alone
    //   single       500          0     500   <- wins on bytesIn alone
    const [n1, n2] = [await mkNode(), await mkNode()];
    const spread = await mkUser();
    const outHeavy = await mkUser();
    const single = await mkUser();
    await usage(n1, spread.id, 50, 250);
    await usage(n2, spread.id, 50, 250); // and still merged across two nodes
    await usage(n1, outHeavy.id, 0, 550);
    await usage(n1, single.id, 500, 0);
    const one = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/users?topUsersLimit=1`,
      headers: bearer,
      payload: { nodesUuids: [n1, n2] },
    });
    const top = one.json().response.topUsers as { user: { uuid: string }; total: number }[];
    expect(top).toHaveLength(1);
    expect(top[0].user.uuid).toBe(spread.id);
    expect(top[0].total).toBe(600);

    // And the whole order, not just the head. This is what a limit larger than
    // the answer would hand an operator.
    //
    // What it does NOT catch on its own: deleting the sort outright. Then the
    // order is whatever the database returned, which on a fixture this small
    // can happen to be right. Every ranking rule that is WRONG rather than
    // ABSENT is caught above, deterministically.
    const all = await app.inject({
      method: 'POST',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/users`,
      headers: bearer,
      payload: { nodesUuids: [n1, n2] },
    });
    const ranked = (all.json().response.topUsers as { user: { uuid: string }; total: number }[])
      .filter((t) => [spread.id, outHeavy.id, single.id].includes(t.user.uuid));
    expect(ranked.map((t) => [t.user.uuid, t.total])).toEqual([
      [spread.id, 600],
      [outHeavy.id, 550],
      [single.id, 500],
    ]);
  });
});

describe('GET /bandwidth-stats/nodes/{uuid}/users', () => {
  /**
   * Untested until now, and it can afford it least: the shop's premium billing
   * worker reads this per node to decide how much premium traffic each user
   * owes (tariff_worker_premium_usage.py). Mutation-checked the way the gap was
   * found - the handler could answer an empty list and all 141 tests in this
   * module still passed.
   */
  it('ranks and cuts on the number it reports, not on one direction', async () => {
    const n = await mkNode();
    const out = await mkUser(); // 50 in + 500 out = 550
    const inb = await mkUser(); // 400 in +   0 out = 400
    await usage(n, out.id, 50, 500);
    await usage(n, inb.id, 400, 0);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/${n}/users?topUsersLimit=1`,
      headers: bearer,
    });
    const top = res.json().response.topUsers as { user: { uuid: string }; total: number }[];
    // Cut by bytesIn, `inb` survives and `out` - the bigger user - is dropped,
    // and the shop bills that user's premium traffic as zero.
    expect(top).toHaveLength(1);
    expect(top[0].user.uuid).toBe(out.id);
    expect(top[0].total).toBe(550);
  });

  it('names the users it returns', async () => {
    const n = await mkNode();
    const u = await mkUser();
    await usage(n, u.id, 700, 300);
    const res = await app.inject({
      method: 'GET',
      url: `/${PREFIX}/api/bandwidth-stats/nodes/${n}/users`,
      headers: bearer,
    });
    const top = res.json().response.topUsers as {
      user: { uuid: string; username: string | null };
      total: number;
    }[];
    expect(top).toEqual([{ user: { uuid: u.id, username: u.username }, total: 1000 }]);
  });
});

describe('POST /connections/drop', () => {
  it('answers A219 when no active node matches, rather than claiming success', async () => {
    // A219 is the client's own "no connected node matched"; it logs "nothing to
    // tear down" and moves on. A 200 would claim we dropped sessions on nodes
    // that do not exist.
    const u = await mkUser();
    const res = await post('connections/drop', {
      dropBy: { by: 'userIds', userIds: [u.numericId] },
      targetNodes: { target: 'specificNodes', nodeUuids: ['00000000-0000-4000-8000-0000000000ff'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('A219');
  });

  it('queues an addUser repair when a node call fails, instead of leaving the user off', async () => {
    // The node address is unreachable in tests, so every removeUser/addUser
    // throws - which is precisely the failure this route must not paper over.
    // Removing an ACTIVE user and not adding them back is worse than not
    // serving the route at all, so the user is handed to the idempotent job.
    const { nodeUsersQueue } = await import('../users/users.queue.js');
    const u = await mkUser();
    await mkNode();
    const before = await nodeUsersQueue.getJobCountByTypes('waiting', 'delayed', 'active');
    const res = await post('connections/drop', {
      dropBy: { by: 'userIds', userIds: [u.numericId] },
      targetNodes: { target: 'allNodes' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().response as { affectedRows: number; repairQueued?: number };
    expect(body.affectedRows).toBe(0);
    expect(body.repairQueued).toBe(1);
    const after = await nodeUsersQueue.getJobCountByTypes('waiting', 'delayed', 'active');
    expect(after).toBeGreaterThan(before);
    // Generous: the node address does not resolve, so every call spends a real
    // DNS failure. The point is the repair, not the latency.
  }, 30_000);
});

/**
 * "Re-push every active node" is the button an operator reaches for when the
 * fleet is wrong and they do not know which node it is. Measured before
 * writing: the fan-out replaced with `Promise.all([])` — every node counted,
 * none pushed — and the full 1693-test suite stayed green. The route answers
 * `{restarted: N}` either way, and N is read off the query, not off what was
 * done, so the reply is the same sentence whether or not anything happened.
 *
 * Observed at the dirty flag, because that is the thing that makes a push
 * happen: BullMQ rejects a duplicate jobId while one is active, so the flag is
 * what the running worker re-reads at the end of its cycle. A job queued
 * without it is a push that can still be swallowed.
 */
describe('POST /nodes/actions/restart-all', () => {
  it('flags every active node for a re-push, and skips the disabled one', async () => {
    const { redis } = await import('../../lib/redis.js');
    const { inboundDirtyKey, inboundSyncQueue } = await import('../inbounds/inbounds.queue.js');
    const a = await mkNode();
    const b = await mkNode();
    const off = await mkNode();
    await prisma.node.update({ where: { id: off }, data: { status: 'disabled' } });
    // Only our own three keys, by full name. The test Redis is shared, so a
    // prefix-glob cleanup here would reach a live panel's queue.
    await redis.del(inboundDirtyKey(a), inboundDirtyKey(b), inboundDirtyKey(off));

    const res = await post('nodes/actions/restart-all');
    expect(res.statusCode).toBe(200);

    expect(await redis.get(inboundDirtyKey(a))).toBe('1');
    expect(await redis.get(inboundDirtyKey(b))).toBe('1');
    expect(
      await redis.get(inboundDirtyKey(off)),
      'a disabled node was told to re-push; its agent is not there to answer',
    ).toBeNull();

    // The job the flag rides with, keyed per node so back-to-back requests
    // coalesce into one push rather than N restarts.
    expect(await inboundSyncQueue.getJob(`apply-${a}`)).toBeTruthy();

    // The count is the operator's only feedback, so it has to be the number of
    // nodes actually flagged and not, say, every row in the table.
    const active = await prisma.node.count({ where: { deletedAt: null, status: { not: 'disabled' } } });
    expect((res.json().response as { restarted: number }).restarted).toBe(active);

    for (const id of [a, b, off]) {
      await redis.del(inboundDirtyKey(id));
      await (await inboundSyncQueue.getJob(`apply-${id}`))?.remove().catch(() => undefined);
    }
  });
});
