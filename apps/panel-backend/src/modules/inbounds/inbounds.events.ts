import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { inboundSyncQueue, inboundDirtyKey } from './inbounds.queue.js';
import { redis } from '../../lib/redis.js';

/**
 * Register inbound-related event handlers.
 *
 * `node.*`, `binding.*` and `profile.*` all collapse to a single job:
 * "recompute the full inbound set for this node and push it through mTLS."
 * Idempotent, re-firing for an unchanged set is a node-side no-op, so we don't
 * try to dedupe at the producer level.
 *
 * There were three `inbound.*` handlers here too, for an Inbound CRUD that no
 * longer exists: no route, no service, prisma.inbound queried nowhere. Nothing
 * had emitted those events for months and the handlers sat subscribed, which
 * reads exactly like a live path. Removed 2026-08-27.
 *
 * The job ID is per-node so multiple back-to-back inbound mutations on the
 * same node coalesce into one push instead of triggering N restarts.
 */
/**
 * One subscription per process. The bus has `on` and no `off`, so a second call
 * adds a SECOND handler for every event here and both keep firing forever.
 *
 * Today there is exactly one call, from `index.ts`. The guard is here because
 * the plausible refactor is moving that call into `buildApp()`, which the test
 * suite invokes per case — and because the same guard already exists in
 * webhook.events.ts for exactly this reason, on one registrar out of five. A
 * decision applied to one of five places is the shape this repository keeps
 * finding; this closes the other four.
 *
 * Doubled here means two inbound pushes per edit. The job ID is per-node so the
 * queue coalesces them, which is precisely why this would go unnoticed rather
 * than show up as visible breakage.
 */
let registered = false;

export function registerInboundEventHandlers(): void {
  if (registered) return;
  registered = true;
  const enqueue = (nodeId: string, reason: string): void => {
    console.log(`[event] ${reason}: enqueue applyInbounds for node ${nodeId}`);
    // Set a dirty flag BEFORE enqueuing. If a worker is already mid-push
    // for this node, BullMQ silently rejects the duplicate jobId, the
    // worker's end-of-job check sees this flag and re-enqueues so the
    // intermediate edit doesn't disappear. See applyInboundsForNode.
    void redis.set(inboundDirtyKey(nodeId), '1').catch(() => null);
    void inboundSyncQueue.add(
      'applyNodeInbounds',
      { nodeId },
      // Coalesce: if an `applyNodeInbounds` is already queued for this node,
      // don't add another. The currently-running one will read the latest
      // state from the DB anyway. `removeOnComplete` cleans up later.
      { jobId: `apply-${nodeId}` },
    );
  };

  // When a node is registered, also push its (currently empty) inbound set,
  // sets the node-agent into a known good state (no leftover from a previous
  // re-bootstrap) and exercises the auto-push pipeline immediately.
  eventBus.on('node.created', ({ nodeId, nodeName }) => {
    enqueue(nodeId, `node.created ${nodeName}`);
  });

  // node.updated → a config-affecting node field changed (the self-steal
  // REALITY domain). Re-push so the live node config tracks Node.domain
  // instead of drifting until an unrelated edit/restart fires.
  eventBus.on('node.updated', ({ nodeId, nodeName }) => {
    enqueue(nodeId, `node.updated ${nodeName}`);
  });

  // ───── Slice 27: Profile + Binding events ─────
  //
  // binding.* is per-(profile, node), only that node needs re-push.
  // profile.* changed shared config, every bound node needs re-push.

  eventBus.on('binding.created', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.created ${bindingId}`);
  });
  eventBus.on('binding.updated', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.updated ${bindingId}`);
  });
  eventBus.on('binding.deleted', ({ bindingId, nodeId }) => {
    enqueue(nodeId, `binding.deleted ${bindingId}`);
  });

  eventBus.on('profile.updated', ({ profileId }) => {
    void prisma.profileNodeBinding
      .findMany({ where: { profileId }, select: { nodeId: true } })
      .then((rows) => {
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.nodeId)) continue;
          seen.add(r.nodeId);
          enqueue(r.nodeId, `profile.updated ${profileId}`);
        }
      })
      .catch((err: unknown) =>
        console.error(`[event] profile.updated fan-out failed:`, err),
      );
  });

  eventBus.on('profile.deleted', ({ profileId, affectedNodeIds }) => {
    for (const nodeId of affectedNodeIds) {
      enqueue(nodeId, `profile.deleted ${profileId}`);
    }
  });

  // ───── wg-пиры при появлении и смене статуса пользователя ─────
  //
  // Очередь `node-users` шлёт `addUser` БЕЗ wg-полей, и это осознанно: пиру
  // нужен публичный ключ И адрес из подсети инбаунда, а транспорт `addUser`
  // несёт один ключ на флейвор — три устройства в него не помещаются. Адреса
  // же выделяет только этот push: он один знает привязки, а значит и подсети.
  //
  // Из-за этого заведение пользователя и возврат его в `active` давали
  // «`addUser … ok`» в логе и НИ ОДНОГО пира на ноде: xray-пользователь
  // добавлялся вживую, sing-box перезапускался, а wg-доступ не появлялся,
  // пока оператор руками не пересохранит профиль или не переключит привязку.
  // Снаружи это ровно «wg перестал подключаться»: панель отдаёт валидный
  // .conf с ключом, которого на ноде нет, и клиент молча не проходит
  // handshake. Воспроизведено 2026-09-01 на пользователе `wgprobe`.
  //
  // Толкаем только ноды, несущие wireguard/amneziawg: applyInbounds отдаёт
  // ноде весь набор инбаундов, и звать его на ноде без wg значило бы трогать
  // xray и sing-box ради протокола, которого там нет.
  const enqueueWgBearingNodes = (reason: string): void => {
    void prisma.profileNodeBinding
      .findMany({
        where: {
          enabled: true,
          profile: { enabled: true, protocol: { in: ['wireguard', 'amneziawg'] } },
        },
        select: { nodeId: true },
      })
      .then((rows) => {
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.nodeId)) continue;
          seen.add(r.nodeId);
          enqueue(r.nodeId, reason);
        }
      })
      .catch((err: unknown) =>
        console.error(`[event] ${reason} wg fan-out failed:`, err),
      );
  };

  eventBus.on('user.created', ({ userId, username }) => {
    enqueueWgBearingNodes(`user.created ${username} (${userId}) wg peers`);
  });

  // Любая смена статуса, а не только переход в `active`: набор строится из
  // `fetchActiveUsers()`, поэтому включённому этот прогон возвращает пира, а у
  // выключенного перестаёт его публиковать.
  //
  // Перестаёт публиковать — не значит снимает. Агент пиров не сверяет сам: он
  // добавляет их по `AddUser` и удаляет по `RemoveUser` с тем же id. Снятие
  // живёт в `users.queue.ts`, которая шлёт removeUser по id каждого устройства,
  // а полную сверку набора — `/retainUsers` в конце этого же синка.
  eventBus.on('user.status-changed', ({ userId, from, to }) => {
    enqueueWgBearingNodes(`user.status-changed ${from} → ${to} (${userId}) wg peers`);
  });

  // Удаление — тоже.
  //
  // `removeUser` из `users.queue.ts` называет ноде id, которые панель помнит, и
  // этого достаточно ровно до тех пор, пока в ту же секунду не идёт синк,
  // прочитавший пользователей ДО коммита удаления: он допишет пиров уже после
  // того, как их сняли, и промолчит об этом. Сверку набора умеет только
  // `inbound-sync` (`/retainUsers`), и до сих пор удаление её не заказывало —
  // значит лишнего снимал следующий синк, какой бы ни случился, и в окне между
  // ними удалённый покупатель ходил.
  //
  // Заказ ставится ПОСЛЕ коммита (событие emit'ится из `deleteUser`, где строка
  // уже сохранена), а флаг «грязно» перед постановкой в очередь гарантирует
  // повторный прогон даже тогда, когда синк уже идёт — новый прочитает
  // актуальный набор.
  eventBus.on('user.deleted', ({ userId }) => {
    enqueueWgBearingNodes(`user.deleted (${userId}) wg peers`);
  });

  // Устройство завели или отозвали — набор пиров на wg-нодах устарел.
  //
  // Это та же поломка, что описана выше для `user.created`, только приходящая
  // с другой стороны: пользователь не менялся вовсе, а ключ появился. Заводит
  // устройства в том числе **выдача подписки** — она дотягивает покупателя до
  // его числа устройств, — и до этого обработчика такая выдача не говорила
  // ноде ничего. Покупатель скачивал валидный `.conf` с ключом, которого на
  // машине нет, и не подключался; само это не чинилось никогда, потому что
  // повторный пуш по cron бывает только на смене статуса ноды.
  //
  // Воспроизведено 02.09 служебной учёткой: у заведённого взамен отозванного
  // устройства в панели есть адреса, а публичного ключа нет ни на `wg0`, ни на
  // `awg0`.
  eventBus.on('wg-devices.changed', ({ userId, reason }) => {
    enqueueWgBearingNodes(`wg-devices.changed ${reason} (${userId})`);
  });

  // cascade.changed → re-push every node that is now or was a hop, so the xray
  // cascade fragments get injected (create/enable) or removed (disable/delete).
  // The cascade service computes the union of old+new hop nodes.
  eventBus.on('cascade.changed', ({ nodeIds }) => {
    for (const nodeId of nodeIds) {
      enqueue(nodeId, `cascade.changed`);
    }
  });
}
