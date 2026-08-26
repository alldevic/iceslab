// What `POST /api/users/bulk` actually DOES.
//
// Correction to the note I nearly wrote: this route is not untested, its
// SCHEMA is - `users.bulk.test.ts` covers the cap, the empty batch, the unknown
// verb and extend-without-a-span. What nothing covered is the behaviour behind
// them: six verbs, three of which take access away, over up to 500 ids in one
// call. A reseller's billing cycle runs through here, so a wrong verb or a
// batch that abandons itself halfway is a few hundred paying customers in the
// wrong state with nothing on screen saying which ones.
//
// Not to be confused with `/api/users/bulk/update-squads`, which IS covered:
// that one is the facade's, declared in remnawave.routes.ts.
//
// Each verb is observed where it takes effect. `revoke` is checked at the
// subscription endpoint the client polls, because a revoke that stamped its
// column and left /sub serving would look identical in the database and be
// worthless in production.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { MAX_BULK_USERS } from './users.schemas.js';

let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

interface MadeUser {
  id: string;
  username: string;
  subscriptionToken: string;
}

async function makeUser(over: Record<string, unknown> = {}): Promise<MadeUser> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: auth(),
    payload: { username: `bulk_user_${seq}`, ...over },
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body) as MadeUser;
}

function bulk(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/users/bulk', headers: auth(), payload });
}

function row(id: string) {
  return prisma.user.findUniqueOrThrow({ where: { id } });
}

describe('the batch reports itself honestly', () => {
  it('needs a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/bulk',
      payload: { userIds: [randomUUID()], action: 'delete' },
    });
    expect(res.statusCode).toBe(401);
  });

  // The decision this route is built around: a blanket 4xx would tell the
  // caller nothing about WHICH of two hundred ids went wrong, and rolling the
  // batch back over three stale ids would be worse than doing the other
  // hundred and ninety-seven.
  it('does the rest of the batch when one id is stale, and says which failed', async () => {
    const alive = await makeUser();
    const alsoAlive = await makeUser();
    const ghost = randomUUID();

    const res = await bulk({ userIds: [alive.id, ghost, alsoAlive.id], action: 'disable' });

    expect(res.statusCode, 'a partly-failed batch is still a 200 carrying a report').toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe('disable');
    expect(body.requested).toBe(3);
    expect(body.succeeded).toBe(2);
    expect([...body.ok].sort()).toEqual([alive.id, alsoAlive.id].sort());
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].userId, 'the report must name the id, not just the count').toBe(ghost);
    expect(body.failed[0].error).toBeTruthy();

    expect((await row(alive.id)).status).toBe('disabled');
    expect((await row(alsoAlive.id)).status).toBe('disabled');
  });

  // The schema refusing an over-cap batch is covered next door; what is checked
  // here is that the ROUTE runs it, and that a refused batch touched nobody. A
  // route that forgot the parse would pass every schema test in the sibling
  // file and still delete a thousand users.
  it('refuses an over-cap batch without touching anyone', async () => {
    const user = await makeUser();
    const ids = [user.id, ...Array.from({ length: MAX_BULK_USERS }, () => randomUUID())];

    const res = await bulk({ userIds: ids, action: 'delete' });

    expect(res.statusCode).toBe(400);
    expect((await row(user.id)).deletedAt, 'an over-cap batch must be refused whole').toBeNull();
  });
});

describe('extend', () => {
  // Renewing early must not shorten a subscription. A reseller extending a
  // month before the date would otherwise silently reset every customer's
  // expiry to "today plus thirty".
  it('extends from the CURRENT expiry while it is still in the future', async () => {
    const future = new Date(Date.now() + 10 * 86400_000);
    const user = await makeUser({ expireAt: future.toISOString() });

    const res = await bulk({ userIds: [user.id], action: 'extend', expireDays: 30 });
    expect(res.statusCode, res.body).toBe(200);

    const got = (await row(user.id)).expireAt!;
    expect(
      Math.abs(got.getTime() - (future.getTime() + 30 * 86400_000)),
      'extending early must add to the paid time, not replace it',
    ).toBeLessThan(60_000);
  });

  it('extends from now when the subscription has already lapsed', async () => {
    const past = new Date(Date.now() - 10 * 86400_000);
    const user = await makeUser({ expireAt: past.toISOString() });

    await bulk({ userIds: [user.id], action: 'extend', expireDays: 7 });

    const got = (await row(user.id)).expireAt!;
    expect(Math.abs(got.getTime() - (Date.now() + 7 * 86400_000))).toBeLessThan(60_000);
    expect(got.getTime(), 'a lapsed user must end up in the future').toBeGreaterThan(Date.now());
  });

  // Without the schema's refusal the route would compute `undefined * 86400000`
  // and stamp an Invalid Date over a real expiry. Checked here against a real
  // row, so what is asserted is that the expiry SURVIVED.
  it('leaves the expiry untouched when the span is missing', async () => {
    const user = await makeUser({ expireAt: new Date(Date.now() + 86400_000).toISOString() });
    const before = (await row(user.id)).expireAt;

    const res = await bulk({ userIds: [user.id], action: 'extend' });

    expect(res.statusCode).toBe(400);
    expect((await row(user.id)).expireAt).toEqual(before);
  });
});

describe('the three verbs that take access away', () => {
  it('revoke makes the subscription link answer 403 REVOKED', async () => {
    const user = await makeUser();
    const before = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}` });
    expect(before.statusCode, 'the link works before the batch').toBe(200);

    const res = await bulk({ userIds: [user.id], action: 'revoke' });
    expect(JSON.parse(res.body).succeeded).toBe(1);

    const after = await app.inject({ method: 'GET', url: `/sub/${user.subscriptionToken}` });
    expect(after.statusCode).toBe(403);
    expect(after.body).toContain('REVOKED');
  });

  it('delete takes the user off the roster and keeps the row', async () => {
    const user = await makeUser();

    const res = await bulk({ userIds: [user.id], action: 'delete' });
    expect(JSON.parse(res.body).succeeded).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: auth() });
    expect(JSON.parse(list.body).users.map((u: MadeUser) => u.id)).not.toContain(user.id);
    const one = await app.inject({ method: 'GET', url: `/api/users/${user.id}`, headers: auth() });
    expect(one.statusCode).toBe(404);
    // Soft: the row survives, which is what keeps the traffic history readable
    // and the delete reversible by hand.
    expect((await row(user.id)).deletedAt).not.toBeNull();
  });

  it('reset-traffic zeroes the counter and leaves the lifetime total alone', async () => {
    const user = await makeUser();
    await prisma.userTraffic.upsert({
      where: { userId: user.id },
      create: { userId: user.id, usedTrafficBytes: 5_000n, lifetimeTrafficBytes: 5_000n },
      update: { usedTrafficBytes: 5_000n, lifetimeTrafficBytes: 5_000n },
    });

    const res = await bulk({ userIds: [user.id], action: 'reset-traffic' });
    expect(JSON.parse(res.body).succeeded).toBe(1);

    const traffic = await prisma.userTraffic.findUniqueOrThrow({ where: { userId: user.id } });
    expect(traffic.usedTrafficBytes).toBe(0n);
    expect(
      traffic.lifetimeTrafficBytes,
      'the lifetime total is the audit trail; a reset must not erase it',
    ).toBe(5_000n);
  });
});

describe('one verb does one thing', () => {
  // The switch is six cases over the same rows. A fallthrough between two of
  // them is invisible in any test that only checks the verb it asked for, so
  // each of these asserts what must NOT have moved.
  it('disable flips the status and touches nothing else', async () => {
    const user = await makeUser({ expireAt: new Date(Date.now() + 86400_000).toISOString() });
    const before = await row(user.id);

    await bulk({ userIds: [user.id], action: 'disable' });

    const after = await row(user.id);
    expect(after.status).toBe('disabled');
    expect(after.deletedAt, 'disable must not delete').toBeNull();
    expect(after.subRevokedAt, 'disable must not revoke the link').toBeNull();
    expect(after.expireAt, 'disable must not touch the expiry').toEqual(before.expireAt);
  });

  it('revoke kills the link and leaves the account alive', async () => {
    const user = await makeUser();

    await bulk({ userIds: [user.id], action: 'revoke' });

    const after = await row(user.id);
    expect(after.subRevokedAt).not.toBeNull();
    expect(after.status, 'revoking a link is not disabling the account').toBe('active');
    expect(after.deletedAt).toBeNull();
  });

  it('enable brings a disabled user back', async () => {
    const user = await makeUser();
    await bulk({ userIds: [user.id], action: 'disable' });
    expect((await row(user.id)).status).toBe('disabled');

    await bulk({ userIds: [user.id], action: 'enable' });
    expect((await row(user.id)).status).toBe('active');
  });

  // The reason the route exists at all: hundreds at a time, one report.
  it('carries every user in a batch, not just the first', async () => {
    const users = [];
    for (let i = 0; i < 12; i += 1) users.push(await makeUser());

    const res = await bulk({ userIds: users.map((u) => u.id), action: 'disable' });

    const body = JSON.parse(res.body);
    expect(body.requested).toBe(12);
    expect(body.succeeded).toBe(12);
    expect(body.failed).toHaveLength(0);
    for (const u of users) {
      expect((await row(u.id)).status, `${u.username} was skipped`).toBe('disabled');
    }
  });
});
