import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Live-risk (3) from docs/remnawave-compat.md §14: paging under churn.
 *
 * `/users/stream` is the ONLY way the shop enumerates a 3.x panel - for
 * RW3_NUMERIC it refuses the legacy `/users` fallback outright - and what it
 * does with the result is decide who still exists. A user missing from the walk
 * is PANEL_USER_NOT_FOUND: is_active=False, notifications off, a paid
 * subscription quietly ended.
 *
 * The cursor used to be an offset with a cursor's name on it. Delete one row
 * ahead of the cursor between two pages and the whole tail shifts by one, so
 * exactly one user is never returned - and it is not the deleted one.
 *
 * These tests walk the stream while the set changes underneath, which is the
 * only way to tell a keyset cursor from an offset: both look identical on a
 * quiet panel.
 */

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const PREFIX = 'rw';
const adminToken = `icp_cursor_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Every user this file makes carries the same telegram id, and the stream is
// walked with that filter: the test database is shared with the rest of the
// suite, and a walk over "every user on the panel" would be a walk over
// whatever else happens to be there.
const COHORT = 990000000000n + BigInt(Date.now() % 1_000_000);

const bearer = { authorization: `Bearer ${adminToken}` };
const get = (url: string) =>
  app.inject({ method: 'GET', url: `/${PREFIX}/api/${url}`, headers: bearer });
const post = (url: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/${PREFIX}/api/${url}`,
    headers: bearer,
    ...(payload === undefined ? {} : { payload }),
  });

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
  await prisma.apiToken.createMany({
    data: [{ name: 'cursor-admin', tokenHash: sha(adminToken), scopes: [] }],
    skipDuplicates: true,
  });
});

afterAll(async () => {
  await prisma.groupMember.deleteMany({ where: { user: { telegramId: COHORT } } });
  await prisma.userTraffic.deleteMany({ where: { user: { telegramId: COHORT } } });
  await prisma.user.deleteMany({ where: { telegramId: COHORT } });
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(adminToken) } });
  await app.close();
});

let seq = 0;
async function mkUser(): Promise<number> {
  seq += 1;
  const res = await post('users', {
    username: `cursor_${Date.now()}_${seq}`,
    telegramId: Number(COHORT),
  });
  expect(res.statusCode).toBe(200);
  return res.json().response.id as number;
}

/** One page of the cohort's stream. */
async function page(size: number, cursor?: string) {
  const qs = `users/stream?size=${size}&telegramId=${COHORT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await get(qs);
  expect(res.statusCode).toBe(200);
  const body = res.json().response;
  return {
    ids: (body.users as { id: number }[]).map((u) => u.id),
    nextCursor: body.nextCursor as string | null,
  };
}

describe('/users/stream pages by keyset, so churn cannot hide a subscriber', () => {
  it('returns every user exactly once when a row is deleted ahead of the cursor mid-walk', async () => {
    const N = 9;
    const created: number[] = [];
    for (let i = 0; i < N; i += 1) created.push(await mkUser());

    const seen: number[] = [];
    const first = await page(3);
    seen.push(...first.ids);
    expect(first.ids).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();

    // Delete a user the walk has ALREADY passed. Under offset paging this is
    // what shifts the tail: page two then starts one row late and the user at
    // the old boundary is never returned. Under a keyset cursor the boundary is
    // a row, not a count, so nothing moves.
    const victim = first.ids[0]!;
    const victimRow = await prisma.user.findFirst({
      where: { numericId: BigInt(victim) },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: victimRow.id },
      data: { deletedAt: new Date() },
    });

    let cursor = first.nextCursor;
    while (cursor) {
      const p = await page(3, cursor);
      seen.push(...p.ids);
      cursor = p.nextCursor;
    }

    // Everyone except the one actually deleted, each exactly once.
    const expected = created.filter((id) => id !== victim).sort();
    expect([...new Set(seen)].length).toBe(seen.length); // no duplicates
    expect(seen.filter((id) => id !== victim).sort()).toEqual(expected);
  });

  it('does not lose the tail when a user is created ahead of the cursor mid-walk', async () => {
    const N = 6;
    const created: number[] = [];
    for (let i = 0; i < N; i += 1) created.push(await mkUser());

    const seen: number[] = [];
    const first = await page(2);
    seen.push(...first.ids);

    // A signup during the sync. The walk may or may not include it - it did not
    // exist when the walk began, and the next sync will find it - but it must
    // not displace anyone who did.
    const latecomer = await mkUser();

    let cursor = first.nextCursor;
    while (cursor) {
      const p = await page(2, cursor);
      seen.push(...p.ids);
      cursor = p.nextCursor;
    }

    for (const id of created) {
      expect(seen, `user ${id} vanished from the walk`).toContain(id);
    }
    expect([...new Set(seen)].length).toBe(seen.length);
    expect(seen).not.toContain(undefined);
    expect(latecomer).toBeGreaterThan(0);
  });

  it('hands out a keyset cursor, and stops with a null one', async () => {
    for (let i = 0; i < 3; i += 1) await mkUser();
    const first = await page(2);
    expect(first.nextCursor).toMatch(/^k1\.\d+$/);
    // The cursor names the last row of the page, which is what makes it a
    // keyset cursor rather than a count.
    expect(first.nextCursor).toBe(`k1.${first.ids[first.ids.length - 1]}`);

    let cursor = first.nextCursor;
    let guard = 0;
    while (cursor && guard < 20) {
      const p = await page(2, cursor);
      cursor = p.nextCursor;
      guard += 1;
    }
    expect(cursor).toBeNull();
  });

  it('still honours a bare numeric cursor, so a walk in flight across a deploy survives', async () => {
    const N = 5;
    for (let i = 0; i < N; i += 1) await mkUser();
    const all = await page(50);
    expect(all.ids.length).toBeGreaterThanOrEqual(N);

    // The old format: an offset, and a PAGE-ALIGNED one - the offset is turned
    // into a page number, which is all it ever had to handle, because the only
    // caller advanced it by exactly one page size at a time. Asking for offset
    // 2 at size 2 is the second page.
    const legacy = await page(2, '2');
    expect(legacy.ids).toEqual(all.ids.slice(2, 4));
  });
});
