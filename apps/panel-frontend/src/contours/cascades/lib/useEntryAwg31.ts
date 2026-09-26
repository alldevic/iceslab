import { useQueries, useQuery } from '@tanstack/react-query';
import { listBindings, listProfiles } from '@/lib/domain/profiles';
import { entryHasAwg31 } from '@/contours/cascades/lib/cascadeForm';

/**
 * E58: есть ли на нодах входа AmneziaWG 3.1. Запросы только при входе
 * amneziawg; ключи кэша те же, что у useEntryBystanders, так что второй раз
 * не спрашивается. Пока ответов нет: `undefined`.
 */
export function useEntryAwg31(entryProtocol: string | null | undefined, entryNodeIds: string[]): boolean | undefined {
  const ids = entryNodeIds.filter(Boolean);
  const active = entryProtocol === 'amneziawg' && ids.length > 0;
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles(), enabled: active });
  const bindingQueries = useQueries({
    queries: ids.map((nodeId) => ({
      queryKey: ['bindings', nodeId],
      queryFn: () => listBindings({ nodeId }),
      enabled: active,
    })),
  });
  if (!active) return undefined;
  const bindings = bindingQueries.every((q) => q.data) ? bindingQueries.flatMap((q) => q.data!.bindings) : undefined;
  return entryHasAwg31(bindings, profilesQuery.data?.profiles);
}
