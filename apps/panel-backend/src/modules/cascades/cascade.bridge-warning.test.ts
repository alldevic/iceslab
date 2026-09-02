// Второе направление в каскаде тихо выключает оба моста.
//
// Мост выпускается только при РОВНО ОДНОМ направлении: мостовой трафик не несёт
// пользовательского тега, поэтому при двух направлениях нода не может понять,
// какой выход имелся в виду. Отказ здесь правильный — выбирать страну за
// покупателя было бы хуже. Цена, однако, ложится на покупателя и больше ни на
// кого: wireguard, amneziawg, tuic, anytls, shadowtls и hysteria2 возвращаются к
// прямому выходу с ноды входа, а для этой установки это выход ИЗ РОССИИ. При
// этом переключатель в карточке ноды остаётся включённым.
//
// Единственным следом до сих пор была строка INFO, которую пишет компиляция
// конфига ноды — то есть позже и в другом месте, чем действие оператора.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, updateCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

let seq = 0;
async function node(name: string, opts?: { bridge?: boolean }): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
      ...(opts?.bridge ? { hardening: { bridgeNonXrayInbounds: true } } : {}),
    },
  });
  return row.id;
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('adding a second direction says that it turned the bridges off', () => {
  it('reports the entry node whose bridge the save disabled', async () => {
    const entry = await node('entry', { bridge: true });
    const nl = await node('nl');
    const se = await node('se');
    const c = await createCascade({
      name: 'onegin-cascade',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [nl] }],
    });
    // Контроль: с одним направлением мост жив, и сохранение молчит. Без этой
    // половины тест прошёл бы и на коде, который жалуется всегда.
    const stillOne = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ id: c.directions[0]!.id, countryCode: 'NL', nodeIds: [nl] }],
    });
    expect(stillOne.bridgesDisabled).toEqual([]);

    const after = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [
        { id: c.directions[0]!.id, countryCode: 'NL', nodeIds: [nl] },
        { countryCode: 'SE', nodeIds: [se] },
      ],
    });
    expect(after.bridgesDisabled).toHaveLength(1);
    expect(after.bridgesDisabled![0]!.nodeId).toBe(entry);
    expect(after.bridgesDisabled![0]!.directions).toBe(2);
  });

  it('stays quiet about an entry that never asked for a bridge', async () => {
    // Иначе предупреждение приходит каждому, у кого два направления, и его
    // перестают читать — а читать его нужно ровно в одном случае.
    const entry = await node('entry');
    const nl = await node('nl');
    const se = await node('se');
    const c = await createCascade({
      name: 'plain-cascade',
      enabled: true,
      hideHopsFromSub: true,
      autoProfile: false,
      mode: 'chain',
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [{ countryCode: 'NL', nodeIds: [nl] }],
    });
    const after = await updateCascade(c.id, {
      positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
      directions: [
        { id: c.directions[0]!.id, countryCode: 'NL', nodeIds: [nl] },
        { countryCode: 'SE', nodeIds: [se] },
      ],
    });
    expect(after.bridgesDisabled).toEqual([]);
  });
});
