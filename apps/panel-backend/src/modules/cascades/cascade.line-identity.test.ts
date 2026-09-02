// Имя каскадной строки — это то, чем клиент отличает сервер от сервера.
//
// Клиент, опознающий сервер по имени, на переименование отвечает не
// переименованием: он ДОБАВЛЯЕТ строку и оставляет старую. Замерено у живого
// покупателя 02.09, через пятнадцать минут после того, как строка каскада сменила
// имя при переезде в v4: 1602 соединения в терминальный отказ входа против 901
// через каскад — у одного человека, державшего обе.
//
// До сих пор это имя выводилось на каждом чтении из имени каскада и страны
// выхода, поэтому переименование каскада — операторская правка, к покупателю
// отношения не имеющая, — переименовывало каждому его сервер. Здесь два ответа:
// имя можно закрепить, и любое сохранение, которое имя всё-таки меняет, об этом
// говорит.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, getRouteProfilesByEntryNode, updateCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

let seq = 0;
async function node(name: string, countryCode?: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
      ...(countryCode ? { countryCode } : {}),
    },
  });
  return row.id;
}

/** Имена строк так, как их увидит подписчик у этого входа. */
async function servedLabels(entryNodeId: string): Promise<string[]> {
  const byEntry = await getRouteProfilesByEntryNode([entryNodeId]);
  return (byEntry.get(entryNodeId) ?? []).map((p) => p.label);
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the name a subscriber holds does not move on its own', () => {
  it('survives a rename of the cascade when it is pinned', async () => {
    const entry = await node('entry', 'RU');
    const exit = await node('exit', 'NL');
    const c = await createCascade({
      name: 'onegin-cascade',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit] }],
    });
    const stored = await prisma.cascadeDirection.findFirstOrThrow({ where: { cascadeId: c.id } });

    // Control: без закрепления имя выводится из имени каскада — и переезжает
    // вместе с ним. Это ровно тот дефект.
    expect(await servedLabels(entry)).toEqual(['🇳🇱 onegin-cascade → NL']);
    const renamedCascade = await updateCascade(c.id, { name: 'onegin-2' });
    expect(await servedLabels(entry)).toEqual(['🇳🇱 onegin-2 → NL']);
    // И сохранение об этом сказало: две строки у покупателя, а не одна.
    expect(renamedCascade.lineRenames).toEqual([
      { tag: stored.tag, before: '🇳🇱 onegin-cascade → NL', after: '🇳🇱 onegin-2 → NL' },
    ]);

    // Закрепляем имя — и следующее переименование каскада до клиента не едет.
    await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: stored.id, countryCode: 'NL', nodeIds: [exit], label: '🇳🇱 Нидерланды' }],
    });
    expect(await servedLabels(entry)).toEqual(['🇳🇱 Нидерланды']);

    const after = await updateCascade(c.id, { name: 'onegin-3' });
    expect(await servedLabels(entry), 'a pinned line moved with the cascade name').toEqual([
      '🇳🇱 Нидерланды',
    ]);
    expect(after.lineRenames, 'a save that renamed nothing reported a rename').toEqual([]);
  });

  it('leaves a pinned name alone when the payload does not mention it', async () => {
    // Правка состава пула — самая обычная причина открыть форму, и она не
    // должна снимать закрепление. То же и для клиента, который поля вовсе не
    // знает: старый скрипт деплоя не должен переименовать всем сервер.
    const entry = await node('entry', 'RU');
    const exitA = await node('exit-a', 'NL');
    const exitB = await node('exit-b', 'NL');
    const c = await createCascade({
      name: 'pinned',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [exitA], label: 'Europe' }],
    });
    expect(await servedLabels(entry)).toEqual(['Europe']);
    const stored = await prisma.cascadeDirection.findFirstOrThrow({ where: { cascadeId: c.id } });

    const res = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: stored.id, countryCode: 'NL', nodeIds: [exitA, exitB] }],
    });

    expect(await servedLabels(entry)).toEqual(['Europe']);
    expect(res.lineRenames).toEqual([]);
    // Control: правка действительно прошла.
    expect(res.directions[0]!.nodeIds.sort()).toEqual([exitA, exitB].sort());
    expect(res.directions[0]!.label).toBe('Europe');
    expect(res.directions[0]!.lineLabel).toBe('Europe');
  });

  it('clears the pin when the payload says so, and reports that as a rename', async () => {
    const entry = await node('entry', 'RU');
    const exit = await node('exit', 'NL');
    const c = await createCascade({
      name: 'unpin',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit], label: 'Europe' }],
    });
    const stored = await prisma.cascadeDirection.findFirstOrThrow({ where: { cascadeId: c.id } });

    const res = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      // Пустая строка — это «верни выводимое имя», а не имя из нуля символов:
      // сервер без имени в списке клиента не отличить ни от чего.
      directions: [{ id: stored.id, countryCode: 'NL', nodeIds: [exit], label: '  ' }],
    });

    expect(await servedLabels(entry)).toEqual(['🇳🇱 unpin → NL']);
    expect(res.directions[0]!.label).toBeNull();
    expect(res.lineRenames).toEqual([
      { tag: stored.tag, before: 'Europe', after: '🇳🇱 unpin → NL' },
    ]);
  });

  it('pins the Auto line too, which is the row that spans every exit', async () => {
    // Строка Auto — такой же сервер в списке клиента, и её имя тоже выводилось
    // из имени каскада. Направление закрепить было можно, а её — нет: то есть
    // единственная строка, на которой сидит большинство подписчиков, когда она
    // включена, оставалась непокрытой.
    const entry = await node('entry', 'RU');
    const exitA = await node('exit-a', 'NL');
    const exitB = await node('exit-b', 'DE');
    const c = await createCascade({
      name: 'auto-pin',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: true,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [
        { countryCode: 'NL', nodeIds: [exitA], label: 'Нидерланды' },
        { countryCode: 'DE', nodeIds: [exitB], label: 'Германия' },
      ],
    });
    // Control: строка Auto вообще выдаётся, иначе проверки ниже ни о чём.
    expect(await servedLabels(entry)).toEqual(['⚡ auto-pin → Auto', 'Нидерланды', 'Германия']);

    // Без закрепления переименование каскада её двигает — и об этом сообщают,
    // хотя оба направления закреплены и не сдвинулись.
    const renamed = await updateCascade(c.id, { name: 'auto-pin-2' });
    expect(await servedLabels(entry)).toEqual(['⚡ auto-pin-2 → Auto', 'Нидерланды', 'Германия']);
    expect(renamed.lineRenames).toEqual([
      { tag: 0xffff, before: '⚡ auto-pin → Auto', after: '⚡ auto-pin-2 → Auto' },
    ]);

    // Закрепили — и следующее переименование до клиента не едет.
    const pinned = await updateCascade(c.id, { autoLabel: '⚡ Автовыбор' });
    expect(pinned.autoLabel).toBe('⚡ Автовыбор');
    expect(pinned.autoLineLabel).toBe('⚡ Автовыбор');
    expect(await servedLabels(entry)).toEqual(['⚡ Автовыбор', 'Нидерланды', 'Германия']);

    const after = await updateCascade(c.id, { name: 'auto-pin-3' });
    expect(await servedLabels(entry)).toEqual(['⚡ Автовыбор', 'Нидерланды', 'Германия']);
    expect(after.lineRenames, 'a save that renamed nothing reported a rename').toEqual([]);
  });

  it('says nothing about the Auto line the operator has not asked for', async () => {
    // Отчёт о переименовании читают ровно до тех пор, пока в нём нет шума.
    // Строка, которую никому не выдают, переименоваться не может.
    const entry = await node('entry', 'RU');
    const exit = await node('exit', 'NL');
    const c = await createCascade({
      name: 'no-auto',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [exit], label: 'Нидерланды' }],
    });

    const res = await updateCascade(c.id, { name: 'no-auto-2' });

    expect(res.lineRenames).toEqual([]);
    // Control: выводимое имя строки Auto при этом ЕСТЬ в ответе — форма
    // показывает, что выдаст включение тумблера.
    expect(res.autoLineLabel).toBe('⚡ no-auto-2 → Auto');
  });

  it('reports the country change that renames a line, and not a new direction', async () => {
    // Смена страны выхода имя МЕНЯЕТ, и правильно делает: строка называет
    // назначение, а оно стало другим. Сказать об этом всё равно надо — у
    // покупателя останутся обе. А добавление направления не переименовывает
    // ничего, и в отчёте его быть не должно.
    const entry = await node('entry', 'RU');
    const exitA = await node('exit-a', 'NL');
    const exitB = await node('exit-b', 'DE');
    const c = await createCascade({
      name: 'geo',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [exitA] }],
    });
    const stored = await prisma.cascadeDirection.findFirstOrThrow({ where: { cascadeId: c.id } });

    const res = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [
        { id: stored.id, countryCode: 'DE', nodeIds: [exitB] },
        { countryCode: 'NL', nodeIds: [exitA] },
      ],
    });

    expect(res.lineRenames).toEqual([
      { tag: stored.tag, before: '🇳🇱 geo → NL', after: '🇩🇪 geo → DE' },
    ]);
    // Control: направление добавилось, и в отчёте его нет.
    expect(res.directions).toHaveLength(2);
  });
});
