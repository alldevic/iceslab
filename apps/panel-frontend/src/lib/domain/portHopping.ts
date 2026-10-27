import type { Transport } from '@iceslab/shared';
import type { Node } from '@/lib/domain/nodes';
import { nodeRunsEngine } from '@/lib/domain/engines';

/**
 * Диапазон port hopping hysteria, который ставит установщик ноды по умолчанию.
 * Берётся, только когда нода свой диапазон не сообщила (агент старше поля или
 * не смог прочитать nat-таблицу).
 */
export const DEFAULT_HOP_RANGE = { from: 20000, to: 50000 } as const;

/**
 * Диапазон port hopping этой ноды: тот, что она сообщила из своей nat-таблицы;
 * null, когда она сообщила, что перенаправления нет; по умолчанию, когда не
 * сообщала.
 */
export function nodeHopRange(node: Pick<Node, 'cores'>): { from: number; to: number } | null {
  const reported = node.cores?.portHopping;
  if (!reported) return DEFAULT_HOP_RANGE;
  if (reported.start === 0) return null;
  return { from: reported.start, to: reported.end };
}

/**
 * Попадает ли UDP-порт профиля в диапазон port hopping hysteria этой ноды
 * (ARCH 26.09). Предупреждение, не отказ: сохранение пройдёт, но для этого
 * порта hopping выключается, и клиенты hysteria на нём не соединятся.
 *
 * Только по факту: hysteria среди движков, которые нода сообщила. Нода не
 * отчитывалась: молчит, как и остальные строки по ядрам.
 */
export function portInHopRange(
  transport: Transport,
  port: number | '' | null | undefined,
  node: Pick<Node, 'engines' | 'cores'>,
  range: { from: number; to: number } | null = nodeHopRange(node),
): boolean {
  if (transport !== 'udp') return false;
  if (typeof port !== 'number' || !Number.isInteger(port)) return false;
  if (range === null) return false;
  if (port < range.from || port > range.to) return false;
  return nodeRunsEngine(node, 'hysteria') === true;
}
