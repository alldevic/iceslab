import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { createUser } from './users.service.js';
import { CreateUserSchema } from './users.schemas.js';
import { removalTargetsFor } from './users.queue.js';

/**
 * Кого именно нода должна забыть, когда покупателя выключают или удаляют.
 *
 * Пир снимается тем id, под которым его завели, а завели его под id
 * УСТРОЙСТВА. Агент держит пиров в `a.peers[userID]` и на незнакомый ключ
 * молча возвращает nil, поэтому removeUser с одним лишь id пользователя
 * снимал его из xray и sing-box и не трогал ни одного wg-пира: выключенный
 * покупатель продолжал ходить по WireGuard и AmneziaWG. Измерено на s2
 * 2026-09-01.
 */

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const make = (username: string) => createUser(CreateUserSchema.parse({ username }));

async function device(userId: string, publicKey: string, revoked = false): Promise<string> {
  const row = await prisma.wgDevice.create({
    data: {
      userId,
      privateKey: `priv-${publicKey}`,
      publicKey,
      revokedAt: revoked ? new Date() : null,
    },
  });
  return row.id;
}

describe('ids a removal has to name', () => {
  it('names the person even when they have no wg device', async () => {
    const u = await make('bare');
    expect(await removalTargetsFor(u.id)).toEqual([u.id]);
  });

  it('names every device, because that is the id its peer was pushed under', async () => {
    const u = await make('threephones');
    const ids = [
      await device(u.id, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
      await device(u.id, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='),
      await device(u.id, 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='),
    ];
    const targets = await removalTargetsFor(u.id);
    expect(targets[0]).toBe(u.id);
    expect([...targets].sort()).toEqual([u.id, ...ids].sort());
  });

  // Отозванное устройство `revokeDevice` уже снимал своим removeUser, и повтор
  // для агента — идемпотентный no-op. А вот пропустить устройство, отозванное
  // в тот же момент, что и выключение, значило бы оставить пира на ноде.
  it('names a revoked device too', async () => {
    const u = await make('revokedone');
    const live = await device(u.id, 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=');
    const gone = await device(u.id, 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=', true);
    expect([...(await removalTargetsFor(u.id))].sort()).toEqual([u.id, live, gone].sort());
  });

  // Иначе выключение одного покупателя снесло бы туннели соседнего.
  it('names nobody else’s device', async () => {
    const mine = await make('mine');
    const theirs = await make('theirs');
    await device(theirs.id, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=');
    const own = await device(mine.id, 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG=');
    expect([...(await removalTargetsFor(mine.id))].sort()).toEqual([mine.id, own].sort());
  });
});
