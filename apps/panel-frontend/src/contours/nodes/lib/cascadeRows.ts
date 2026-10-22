import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type Cascade } from '@/lib/domain/cascades';
import { listBindings } from '@/lib/domain/profiles';
import { listRoutePolicies } from '@/lib/domain/routePolicies';
import { listSquads } from '@/lib/domain/squads';
import { type Node } from '@/lib/domain/nodes';
import { useOverview } from '@/lib/domain/dashboard';
import { listNamedOutbounds, outboundAddress } from '@/lib/domain/namedOutbounds';
import {
  cascadePath,
  cascadeReach,
  type DirectionView,
  type HopView,
  type OutboundLookup,
} from '@/lib/domain/cascadePath';
import { apiErrorMessage } from '@/lib/net/client';
import { loadFailure, type LoadFailure } from '@/lib/ui/loadView';

/**
 * The cascade list's glue: it fetches what explains a cascade and hands it to
 * the rules in `lib/domain/cascadePath` (path, reach), which both cascade
 * contours read. Kept in `lib/` of the contour, not beside the markup: a hook
 * in a file with components costs them hot reload.
 */

/** Everything a cascade row or card needs, assembled once per cascade. */
export interface CascadeRow {
  cascade: Cascade;
  entry: HopView | null;
  /** Positions between the entry and the way out, in order. */
  transits: HopView[];
  /** The ways out. The tag identifies the direction, not the node under it. */
  directions: DirectionView[];
  /** Traffic that entered the cascade today: the entry pool's own. */
  todayBytes: number | null;
  /** Who the cascade reaches; `null` while a list it is read from is missing. */
  reach: { squads: { name: string; members: number }[]; policies: { name: string; ordinal: number }[]; users: number } | null;
}

/**
 * Join cascades with everything that explains them: node status and traffic
 * from the dashboard poll, squads and policies from the ACL. Kept in one hook so
 * both densities render off the same numbers. `failure` names the first side
 * list that did not arrive, so the list says it once instead of reading «nobody»
 * on every card (spec frontend-nodes).
 */
export function useCascadeRows(cascades: Cascade[], nodes: Node[]): { rows: CascadeRow[]; failure: LoadFailure | null } {
  const overviewQuery = useOverview();
  const squadsQuery = useQuery({ queryKey: ['squads'], queryFn: listSquads });
  const policiesQuery = useQuery({ queryKey: ['route-policies'], queryFn: listRoutePolicies });
  const bindingsQuery = useQuery({ queryKey: ['bindings'], queryFn: () => listBindings() });
  // Фаза 10 (E57): имя и адрес выхода направления. DTO каскада несёт только
  // outboundId; список выходов тот же, что у их экрана.
  const outboundsQuery = useQuery({ queryKey: ['named-outbounds'], queryFn: listNamedOutbounds });

  const failure =
    [squadsQuery, policiesQuery, bindingsQuery, outboundsQuery]
      .map((q) => loadFailure(q, apiErrorMessage))
      .find((f) => f !== null) ?? null;

  const rows = useMemo(() => {
    const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
    const outbounds: OutboundLookup | null = outboundsQuery.data
      ? new Map(
          outboundsQuery.data.outbounds.map(
            (o) => [o.id, { name: o.name, address: outboundAddress(o), countryCode: o.countryCode }] as const,
          ),
        )
      : null;
    const overviewById = new Map((overviewQuery.data?.nodes ?? []).map((n) => [n.id, n] as const));

    return cascades.map((cascade) => {
      const { entry, transits, directions } = cascadePath(cascade, nodeById, overviewById, outbounds);
      return {
        cascade,
        entry,
        transits,
        directions,
        todayBytes: entry?.todayBytes ?? null,
        reach: cascadeReach(
          (entry?.nodes ?? []).map((n) => n.id),
          bindingsQuery.data?.bindings,
          squadsQuery.data?.squads,
          policiesQuery.data?.policies,
        ),
      };
    });
  }, [cascades, nodes, overviewQuery.data, squadsQuery.data, policiesQuery.data, bindingsQuery.data, outboundsQuery.data]);

  return { rows, failure };
}
