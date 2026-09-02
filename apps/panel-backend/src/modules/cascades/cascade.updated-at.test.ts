// Сохранение каскада двигает его метку времени — включая то сохранение, ради
// которого каскад и правят.
//
// Топология v4 лежит в дочерних строках: позиции, направления, линки. Скалярные
// поля самой записи (`name`, `enabled`, `mode`, `hideHopsFromSub`,
// `autoProfile`) при правке топологии не меняются, поэтому `data` у
// `cascade.update` выходил ПУСТЫМ, а `@updatedAt` в Prisma срабатывает только
// на настоящей записи. Замерено на боевом каскаде 03.09 своим же сохранением:
//
//   cascade_positions.created_at   2026-09-02 05:36:20
//   cascade_links.created_at       2026-09-02 05:36:20
//   cascades.updated_at            2026-09-01 19:44:29   ← на десять часов позади
//
// И это не только дата в интерфейсе. `getCascadeStatus` считает хоп
// применившим конфиг, если `lastInboundSyncAt` ноды позже этой метки, так что
// просроченная метка объявляет `applied` ещё до того, как пуш ушёл.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, getCascadeStatus, updateCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

let seq = 0;
async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return row.id;
}

async function savedAt(id: string): Promise<Date> {
  return (
    await prisma.cascade.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })
  ).updatedAt;
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a cascade save moves the cascade’s own timestamp', () => {
  it('moves it for a save that carries only the topology', async () => {
    // ВАЖНО, какое именно сохранение здесь проверяется. Добавление нового
    // направления выдаёт тег из счётчика `nextDirectionTag`, а он лежит на
    // самой записи каскада — то есть такая правка пишет в строку и двигает
    // метку даже без починки. Первая версия этого теста так и проходила на
    // сломанном коде.
    //
    // Поэтому здесь — пересохранение НЕИЗМЕННОГО состава: ни скалярных полей,
    // ни нового тега. Дочерние строки переписываются, сама запись — нет.
    const entry = await node('entry');
    const exitA = await node('exit-a');
    const exitB = await node('exit-b');
    const c = await createCascade({
      name: 'stamp',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exitA] }, { nodeIds: [exitB] }],
    });
    const before = await savedAt(c.id);
    const tagBefore = (
      await prisma.cascade.findUniqueOrThrow({
        where: { id: c.id },
        select: { nextDirectionTag: true },
      })
    ).nextDirectionTag;
    const stored = await prisma.cascadeDirection.findMany({
      where: { cascadeId: c.id },
      select: { id: true },
      orderBy: { tag: 'asc' },
    });

    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [
        { id: stored[0]!.id, nodeIds: [exitA] },
        { id: stored[1]!.id, nodeIds: [exitB] },
      ],
    });

    const after = await savedAt(c.id);
    // Control: сохранение прошло и НЕ тронуло ни одного скалярного поля само
    // по себе — счётчик тегов на месте, направлений столько же. Иначе проверка
    // ниже доказывала бы, что метку двигает что-то другое.
    expect(await prisma.cascadeDirection.count({ where: { cascadeId: c.id } })).toBe(2);
    expect(
      (
        await prisma.cascade.findUniqueOrThrow({
          where: { id: c.id },
          select: { nextDirectionTag: true },
        })
      ).nextDirectionTag,
      'a new tag was issued, so this save wrote to the cascade row for another reason',
    ).toBe(tagBefore);
    expect(after.getTime(), 'the row still claims nobody has touched it').toBeGreaterThan(
      before.getTime(),
    );
  });

  it('a hop is not "applied" until it has synced since the save', async () => {
    // Вторая сторона той же метки: по ней читается статус применения.
    const entry = await node('entry');
    const exit = await node('exit');
    const c = await createCascade({
      name: 'stamp-status',
      enabled: false,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
    });
    // Нода отчиталась о синке — по прежнему состоянию каскада.
    await prisma.node.update({
      where: { id: entry },
      data: { status: 'online', lastInboundSyncAt: new Date() },
    });
    await prisma.node.update({
      where: { id: exit },
      data: { status: 'online', lastInboundSyncAt: new Date() },
    });
    // Control: до правки статус честно говорит «применено».
    expect((await getCascadeStatus(c.id)).done).toBe(true);

    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ nodeIds: [exit] }],
      hops: [
        { nodeId: entry, position: 0, entryProtocol: 'xray', linkProtocol: 'xray' },
        { nodeId: exit, position: 1 },
      ],
    });

    // Пуш после этого сохранения ещё не уходил, значит ни один хоп не применил
    // то, что только что сохранили.
    const status = await getCascadeStatus(c.id);
    expect(status.done, 'a cascade reports its new config applied before it was sent').toBe(false);
    expect(status.hops.every((h) => !h.applied)).toBe(true);
  });
});
