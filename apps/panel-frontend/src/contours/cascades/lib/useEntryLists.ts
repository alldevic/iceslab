import { useQueries, useQuery } from '@tanstack/react-query';
import { listBindings, listProfiles, type Binding, type Profile } from '@/lib/domain/profiles';
import { apiErrorMessage } from '@/lib/net/client';
import { loadFailure, type LoadFailure } from '@/lib/ui/loadView';

/**
 * Профили и привязки нод входа: общий источник для useEntryBystanders и
 * useEntryAwg31. Ключи кэша те же, что у страницы ноды: `['profiles']` и
 * `['bindings', nodeId]`.
 *
 * `bindings` есть, только когда пришли ВСЕ ответы: частичный список сказал бы
 * «нет» про ноду, которую мы ещё не видели. `failure` отличает «не пришло» от
 * «ещё идёт» (A-172 п.4): раньше оба читались одним `undefined`, и строка на
 * входе молча не появлялась.
 */
export function useEntryLists(
  active: boolean,
  ids: string[],
): { bindings: Binding[] | undefined; profiles: Profile[] | undefined; failure: LoadFailure | null } {
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles(), enabled: active });
  const bindingQueries = useQueries({
    queries: ids.map((nodeId) => ({
      queryKey: ['bindings', nodeId],
      queryFn: () => listBindings({ nodeId }),
      enabled: active,
    })),
  });
  if (!active) return { bindings: undefined, profiles: undefined, failure: null };
  const failure =
    [profilesQuery, ...bindingQueries].map((q) => loadFailure(q, apiErrorMessage)).find((f) => f !== null) ?? null;
  const bindings = bindingQueries.every((q) => q.data) ? bindingQueries.flatMap((q) => q.data!.bindings) : undefined;
  return { bindings, profiles: profilesQuery.data?.profiles, failure };
}
