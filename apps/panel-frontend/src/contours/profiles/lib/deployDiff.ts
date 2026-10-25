/**
 * Что сделать с привязками профиля после окна «Развернуть».
 *
 * Сохранение идёт по привязкам поштучно: POST на каждую новую галку, DELETE на
 * каждую снятую. Списка, который заменяет множество целиком, здесь нет и быть
 * не должно: это ровно инцидент 2026-07-31, когда сохранение сквада стёрло
 * profileIds, которых экран не редактировал.
 *
 * ⚠ Снимается только то, что оператор СНЯЛ САМ: нода была отмечена, когда окно
 * открылось, и сейчас не отмечена. До 23.09 разница считалась против ТЕКУЩЕГО
 * ответа сервера, и привязка, созданная где-то ещё, пока окно открыто (фоновый
 * рефетч её приносил, а галки у неё не было), молча удалялась при сохранении.
 * Экран удалял то, чего оператор не видел и не трогал.
 *
 * Создаётся тоже только новое: нода отмечена и привязки на ней у профиля нет по
 * текущему ответу сервера. Если привязка появилась сама, пока окно открыто,
 * второй раз её не создаём.
 */
export interface DeployDiff {
  /** Ноды, на которые профиль нужно развернуть. */
  create: string[];
  /** Id привязок, которые нужно снять. */
  remove: string[];
}

export function deployDiff(
  /** Ноды, отмеченные в момент открытия окна. */
  seeded: ReadonlySet<string>,
  /** Ноды, отмеченные сейчас. */
  selected: ReadonlySet<string>,
  /** Привязки профиля по текущему ответу сервера. */
  bindings: { id: string; nodeId: string }[],
): DeployDiff {
  const bound = new Set(bindings.map((b) => b.nodeId));
  const create = [...selected].filter((nodeId) => !bound.has(nodeId));
  const remove = bindings
    .filter((b) => seeded.has(b.nodeId) && !selected.has(b.nodeId))
    .map((b) => b.id);
  return { create, remove };
}

/**
 * A-259: the ports the profile listens on, per node. A profile stands on a node
 * once per port, so a row of this window is a node with a LIST of inbounds:
 * the tick takes all of them off, and the row says which before it does.
 */
export function portsByNode(bindings: readonly { nodeId: string; port: number }[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const b of bindings) {
    const list = out.get(b.nodeId) ?? [];
    if (!list.includes(b.port)) list.push(b.port);
    out.set(b.nodeId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}
