import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { uniqueViolationOf } from '../../lib/util/unique-violation.js';
import { userUniqueField, type UserUniqueField } from './users.service.js';

/**
 * A-257: which of a user's four unique constraints a lost race hit, read from
 * the error the database actually raises through the driver adapter, not from
 * a `meta.target` written into a fake. Until now every such race read as a
 * taken name.
 */

let app: FastifyInstance;
let token: string;

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
const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/users', headers: auth(), payload: { ...payload } });

/** The error a second user raises when it repeats `field` of the first, as the
 *  database raises it. */
async function realViolation(field: UserUniqueField): Promise<unknown> {
  const first = await create({ username: 'first', sourceId: 'src-1' });
  expect(first.statusCode, first.body).toBe(201);
  const a = await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(first.body).id as string } });
  // numericId is unique too, and a copied one would collide on its own.
  const { id: _id, createdAt: _c, updatedAt: _u, numericId: _n, ...row } = a;
  const fresh = { username: 'second', shortId: 'second01', subscriptionToken: 'second-token-0000000000000000', sourceId: 'src-2' };
  const repeat = { username: a.username, shortId: a.shortId, subscriptionToken: a.subscriptionToken, sourceId: a.sourceId };
  try {
    await prisma.user.create({ data: { ...row, ...fresh, [field]: repeat[field] } as never });
  } catch (err) {
    return err;
  }
  throw new Error(`no violation on ${field}`);
}

describe('userUniqueField on the errors the database raises', () => {
  const cases: [UserUniqueField, string][] = [
    ['username', 'users_username_active_key'],
    ['subscriptionToken', 'users_subscription_token_key'],
    ['shortId', 'users_short_id_key'],
    ['sourceId', 'users_source_id_key'],
  ];
  for (const [field, index] of cases) {
    it(`${field}: the index ${index}`, async () => {
      const err = await realViolation(field);
      expect(uniqueViolationOf(err)?.index).toBe(index);
      expect(userUniqueField(err)).toBe(field);
    });
  }

  it('anything else is not a field: an unknown index, a non-unique error', () => {
    expect(userUniqueField({ code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { index: 'users_other_key' } } } } })).toBeNull();
    expect(userUniqueField({ code: 'P2003' })).toBeNull();
  });
});

describe('the create answers by the constraint it lost on', () => {
  it('a source id imported twice is SOURCE_ID_TAKEN, not a taken name', async () => {
    expect((await create({ username: 'imp-1', sourceId: 'legacy-42' })).statusCode).toBe(201);
    const again = await create({ username: 'imp-2', sourceId: 'legacy-42' });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body)).toMatchObject({ error: 'SOURCE_ID_TAKEN', field: 'sourceId' });
  });

  it('a race on one imported token: the losers hear the token, never the name', async () => {
    const tok = 'race-token-aaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await Promise.all([0, 1, 2, 3].map((i) => create({ username: `racer-${i}`, subscriptionToken: tok })));
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    for (const r of res.filter((x) => x.statusCode === 409)) {
      expect(JSON.parse(r.body).error, r.body).toBe('SUBSCRIPTION_TOKEN_TAKEN');
    }
  });

  it('a race on one name: the losers hear the name', async () => {
    const res = await Promise.all([0, 1, 2, 3].map(() => create({ username: 'same-name' })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
    for (const r of res.filter((x) => x.statusCode === 409)) {
      expect(JSON.parse(r.body).error, r.body).toBe('USERNAME_TAKEN');
    }
  });
});
