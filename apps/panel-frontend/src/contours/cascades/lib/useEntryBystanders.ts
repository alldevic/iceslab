import { entryBystanders, type EntryBystander } from '@/contours/cascades/lib/cascadeForm';
import { useEntryLists } from '@/contours/cascades/lib/useEntryLists';
import type { LoadFailure } from '@/lib/ui/loadView';

/**
 * Чужие профили на входных нодах, с данными, которые экран каскада сам не грузит.
 *
 * Запросы ЛЕНИВЫЕ: пока вход не выбран или входных нод нет, не уходит ни один.
 * Профили берутся один раз на экран, привязки по каждой входной ноде
 * параллельно (useEntryLists, ключи кэша общие со страницей ноды).
 *
 * Пока хоть один ответ не пришёл, `items` это `undefined`: частичный список
 * привязок сказал бы «чужих профилей нет» про ноду, которую мы ещё не видели.
 * Не пришёл совсем: `failure` со словами сервера (A-172 п.4).
 */
export function useEntryBystanders(
  entryProtocol: string | null | undefined,
  entryNodeIds: string[],
  nodeById: Map<string, { id: string; name: string; countryCode: string | null }>,
): { items: EntryBystander[] | undefined; failure: LoadFailure | null } {
  const ids = entryNodeIds.filter(Boolean);
  const active = Boolean(entryProtocol) && ids.length > 0;
  const { bindings, profiles, failure } = useEntryLists(active, ids);
  if (!active) return { items: undefined, failure: null };
  const nodes = ids
    .map((id) => nodeById.get(id))
    .filter((n): n is { id: string; name: string; countryCode: string | null } => Boolean(n));
  return { items: entryBystanders(entryProtocol, nodes, bindings, profiles), failure };
}
