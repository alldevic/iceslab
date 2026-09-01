import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/event-bus.js';
import { inboundSyncQueue } from './inbounds.queue.js';
import { registerInboundEventHandlers } from './inbounds.events.js';

/**
 * Заведение пользователя не давало ему wg-доступ.
 *
 * `addUser` из очереди `node-users` намеренно не несёт wg-полей: пиру нужен
 * ключ И адрес из подсети инбаунда, а транспорт `addUser` держит один ключ на
 * флейвор — три устройства покупателя в него не помещаются. Адреса выделяет
 * только inbound-push, потому что он один знает привязки и подсети.
 *
 * Пока эти события не были подписаны, лог говорил `addUser … ok`, xray-юзер
 * появлялся вживую, а пира на ноде не было вовсе. Панель при этом выдавала
 * валидный `.conf` с ключом, которого нода не знает: снаружи — «wg перестал
 * подключаться», молча, без единой ошибки. Воспроизведено 2026-09-01.
 *
 * Наблюдаемое — вызов очереди, потому что альтернатива это поднять ноду.
 */

const NODE_WG = '11111111-1111-4111-8111-111111111111';
const NODE_XRAY_ONLY = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  registerInboundEventHandlers();
});

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

async function node(id: string, name: string, address: string): Promise<void> {
  // heartbeatSecret is required (Bytes, no default); any 32 bytes will do.
  await prisma.node.create({
    data: { id, name, address, status: 'online', heartbeatSecret: Buffer.alloc(32) },
  });
}

async function boundProfile(
  nodeId: string,
  name: string,
  protocol: string,
  opts: { profileEnabled?: boolean; bindingEnabled?: boolean; port?: number } = {},
): Promise<void> {
  const profile = await prisma.profile.create({
    data: { name, protocol, config: {}, enabled: opts.profileEnabled ?? true },
  });
  await prisma.profileNodeBinding.create({
    data: {
      profileId: profile.id,
      nodeId,
      // (node_id, port) is unique, so a node carrying two profiles needs two ports.
      port: opts.port ?? 51820,
      enabled: opts.bindingEnabled ?? true,
    },
  });
}

/** Node ids the handler asked inbound-sync to push, once the promise chain settles. */
async function pushedNodes(spy: ReturnType<typeof vi.spyOn>): Promise<string[]> {
  await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 2000 });
  return [...new Set(spy.mock.calls.map((c) => (c[1] as { nodeId: string }).nodeId))].sort();
}

describe('a user who becomes servable gets their wg peers pushed', () => {
  it('pushes the node carrying wireguard when a user is created', async () => {
    await node(NODE_WG, 'wg-node', '10.0.0.1:8443');
    await boundProfile(NODE_WG, 'p-wireguard', 'wireguard');
    const spy = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);

    eventBus.emit('user.created', { userId: 'u-1', username: 'buyer' });

    expect(await pushedNodes(spy)).toEqual([NODE_WG]);
  });

  it('pushes the node carrying amneziawg too', async () => {
    await node(NODE_WG, 'awg-node', '10.0.0.1:8443');
    await boundProfile(NODE_WG, 'p-amneziawg', 'amneziawg');
    const spy = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);

    eventBus.emit('user.created', { userId: 'u-2', username: 'buyer' });

    expect(await pushedNodes(spy)).toEqual([NODE_WG]);
  });

  // applyInbounds отдаёт ноде ВЕСЬ её набор инбаундов и перезапускает ядра.
  // Звать его на ноде без wg — это трогать xray и sing-box ради протокола,
  // которого там нет, на каждом заведённом покупателе.
  it('leaves a node without any wg profile alone', async () => {
    await node(NODE_WG, 'wg-node', '10.0.0.1:8443');
    await node(NODE_XRAY_ONLY, 'xray-node', '10.0.0.2:8443');
    await boundProfile(NODE_WG, 'p-wireguard', 'wireguard');
    await boundProfile(NODE_XRAY_ONLY, 'p-xray', 'xray');
    const spy = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);

    eventBus.emit('user.created', { userId: 'u-3', username: 'buyer' });

    expect(await pushedNodes(spy)).toEqual([NODE_WG]);
  });

  // Выключенная привязка на ноду не едет вовсе, поэтому и звать её незачем:
  // выданный по ней `.conf` всё равно не подписан ни одним живым инбаундом.
  it('ignores a disabled binding and a disabled profile', async () => {
    await node(NODE_WG, 'wg-node', '10.0.0.1:8443');
    await node(NODE_XRAY_ONLY, 'other-node', '10.0.0.2:8443');
    await boundProfile(NODE_WG, 'p-wireguard', 'wireguard');
    await boundProfile(NODE_XRAY_ONLY, 'p-off-binding', 'wireguard', { bindingEnabled: false });
    await boundProfile(NODE_XRAY_ONLY, 'p-off-profile', 'amneziawg', {
      profileEnabled: false,
      port: 51821,
    });
    const spy = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);

    eventBus.emit('user.created', { userId: 'u-4', username: 'buyer' });

    expect(await pushedNodes(spy)).toEqual([NODE_WG]);
  });

  // Толкаем на любой смене статуса: набор строится из fetchActiveUsers(), так
  // что включённому прогон возвращает пира, а у выключенного перестаёт его
  // публиковать. Само снятие пира с ноды — не здесь: агент сверки не делает,
  // и удаление шлёт `users.queue.ts` по id каждого устройства.
  it.each(['active', 'disabled', 'limited'])('pushes on a status change to %s', async (to) => {
    await node(NODE_WG, 'wg-node', '10.0.0.1:8443');
    await boundProfile(NODE_WG, 'p-wireguard', 'wireguard');
    const spy = vi.spyOn(inboundSyncQueue, 'add').mockResolvedValue({} as never);

    eventBus.emit('user.status-changed', { userId: 'u-5', from: 'unknown', to });

    expect(await pushedNodes(spy)).toEqual([NODE_WG]);
  });
});
