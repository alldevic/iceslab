// The user's number and the exact list filters, against a real database: what
// a mocked repository cannot show is the sequence handing out the numbers.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { CreateUserSchema, UpdateUserSchema } from './users.schemas.js';
import * as users from './users.service.js';

const make = (username: string, extra: Record<string, unknown> = {}) =>
  users.createUser(CreateUserSchema.parse({ username, ...extra }));

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('numericId', () => {
  it('is issued to each new user, distinct, and finds the user', async () => {
    const a = await make('num-a');
    const b = await make('num-b');

    expect(a.numericId).toMatch(/^[1-9]\d*$/);
    expect(b.numericId).not.toBe(a.numericId);
    expect((await users.findUserByNumericId(BigInt(a.numericId))).id).toBe(a.id);
    expect((await users.findUserByNumericId(BigInt(b.numericId))).username).toBe('num-b');
  });

  it('does not find a deleted user, and the number is not given out again', async () => {
    const a = await make('num-gone');
    await users.deleteUser(a.id);
    await expect(users.findUserByNumericId(BigInt(a.numericId))).rejects.toBeInstanceOf(
      users.UserNotFoundError,
    );
    const b = await make('num-next');
    expect(BigInt(b.numericId)).toBeGreaterThan(BigInt(a.numericId));
  });
});

describe('the native API fields', () => {
  it('returns a byte limit as written and externalSquadUuid verbatim', async () => {
    const created = await make('rw-user', {
      trafficLimitGb: 3,
      trafficLimitBytes: 1_234_567_891,
      externalSquadUuid: 'not-a-uuid-at-all',
    });
    expect(created.trafficLimitBytes).toBe(1_234_567_891);
    expect(created.externalSquadUuid).toBe('not-a-uuid-at-all');

    const edited = await users.updateUser(
      created.id,
      UpdateUserSchema.parse({ trafficLimitBytes: 99, externalSquadUuid: null }),
    );
    expect(edited.trafficLimitBytes).toBe(99);
    expect(edited.externalSquadUuid).toBeNull();
    expect((await users.getUserById(created.id)).trafficLimitBytes).toBe(99);
  });
});

describe('exact list filters', () => {
  const list = (f: users.InternalUserFilters) =>
    users.listUsers({ page: 1, limit: 50, sort: 'username', order: 'asc', ...f });

  it('match telegramId and email exactly, the email without regard to case', async () => {
    await make('f-one', { telegramId: '123456789', email: 'One@Example.com' });
    await make('f-two', { telegramId: '1234567890', email: 'one@example.com.au' });

    expect((await list({ telegramId: 123456789n })).users.map((u) => u.username)).toEqual(['f-one']);
    expect((await list({ emailEquals: 'one@example.COM' })).users.map((u) => u.username)).toEqual([
      'f-one',
    ]);
    expect((await list({ telegramId: 5n })).total).toBe(0);
  });
});
