import { entryHasAwg31 } from '@/contours/cascades/lib/cascadeForm';
import { useEntryLists } from '@/contours/cascades/lib/useEntryLists';
import type { LoadFailure } from '@/lib/ui/loadView';

/**
 * E58: есть ли на нодах входа AmneziaWG 3.1. Запросы только при входе
 * amneziawg; ключи кэша те же, что у useEntryBystanders, так что второй раз
 * не спрашивается. Пока ответов нет: `undefined`; не пришли: `failure`
 * (A-172 п.4), чтобы «не знаю» не читалось как «не 3.1».
 */
export function useEntryAwg31(
  entryProtocol: string | null | undefined,
  entryNodeIds: string[],
): { awg31: boolean | undefined; failure: LoadFailure | null } {
  const ids = entryNodeIds.filter(Boolean);
  const active = entryProtocol === 'amneziawg' && ids.length > 0;
  const { bindings, profiles, failure } = useEntryLists(active, ids);
  if (!active) return { awg31: undefined, failure: null };
  return { awg31: entryHasAwg31(bindings, profiles), failure };
}
