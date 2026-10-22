import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cascadeDeleteRefusal,
  cascadeToggleRefusal,
  deleteCascade,
  listCascades,
  setCascadeEnabled,
  type Cascade,
} from '@/lib/domain/cascades';
import { listAllNodes } from '@/lib/domain/nodes';
import { apiErrorMessage } from '@/lib/net/client';
import { confirmCascadeDelete } from '@/ui/confirmCascadeDelete';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { FleetEmpty } from '@/contours/nodes/components/FleetEmpty';
import { CascadesView, type CascadeCardRefusal, type CascadeLayout } from '@/contours/nodes/components/CascadesView';
import { useCascadeRows } from '@/contours/nodes/lib/cascadeRows';

/**
 * The "Cascades" sub-view of the Nodes page. A cascade is a chain of nodes, so
 * each hop is drawn as a real node card (flag / status / role / today's
 * traffic), connected entry -> ... -> exit by arrows labelled with the link
 * protocol. Self-contained: pulls its own cascades + node list + overview
 * metrics (react-query dedupes the shared keys with NodesPage).
 *
 * Building and editing a cascade both live on their own pages, so what is left
 * here is the list plus the two actions that need no form: the enabled switch
 * and delete.
 */
export function CascadesPanel({ layout = 'cards' }: { layout?: CascadeLayout }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cascadesQuery = useQuery({ queryKey: ['cascades'], queryFn: listCascades });
  const nodesQuery = useQuery({ queryKey: ['nodes', 'all'], queryFn: () => listAllNodes() });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cascades'] });
  const onError = (err: unknown) => {
    // Cascade writes commit fast and provision nodes asynchronously, so a slow
    // or timed-out response can fire onError even though the change landed.
    // Refetch so the list reflects reality instead of a stale view.
    invalidate();
    notifications.show({ color: 'red', title: t('common.saveError'), message: apiErrorMessage(err) });
  };

  /**
   * Refusals to switch on or to delete, by cascade id (A-126). The card is
   * drawn from the server's `enabled` only, so it never shows «on» before the
   * answer; a refusal the server explained stays under the card in its words
   * instead of a toast that is gone in four seconds. The next try clears it.
   */
  const [refusals, setRefusals] = useState<Record<string, CascadeCardRefusal>>({});
  const clearRefusal = (id: string) =>
    setRefusals((r) => {
      const next = { ...r };
      delete next[id];
      return next;
    });

  const deleteMutation = useMutation({
    mutationFn: deleteCascade,
    onMutate: clearRefusal,
    onSuccess: () => {
      invalidate();
      notifications.show({ color: 'green', message: t('cascades.deleted') });
    },
    // Already gone is what the operator asked for, said as such; any other
    // refusal the server explained goes under the card (cascadeDeleteRefusal).
    onError: (err, id) => {
      const refusal = cascadeDeleteRefusal(err);
      if (!refusal) return onError(err);
      invalidate();
      if (refusal.kind === 'gone') notifications.show({ message: t('cascades.alreadyDeleted') });
      else setRefusals((r) => ({ ...r, [id]: { action: 'delete', code: refusal.code, message: refusal.message } }));
    },
  });

  const enableMutation = useMutation({
    mutationFn: (c: Cascade) => setCascadeEnabled(c.id, !c.enabled),
    onMutate: (c) => clearRefusal(c.id),
    onSuccess: invalidate,
    onError: (err, c) => {
      const refusal = cascadeToggleRefusal(err);
      if (!refusal) return onError(err);
      invalidate();
      setRefusals((r) => ({ ...r, [c.id]: { action: 'enable', ...refusal } }));
    },
  });
  const pendingId = enableMutation.isPending ? enableMutation.variables.id : null;

  const { rows, failure: sideFailure } = useCascadeRows(cascadesQuery.data?.cascades ?? [], nodesQuery.data?.nodes ?? []);

  // Nothing to draw has three causes here and they are not interchangeable:
  // the request failed, the request has not answered yet, or there really are
  // no cascades. The panel says which, because on the first of the three the
  // chains are still carrying traffic.
  if (rows.length === 0) {
    return (
      <Stack gap="md">
        <FleetEmpty
          what="cascades"
          state={
            cascadesQuery.isError
              ? {
                  kind: 'failed',
                  message: apiErrorMessage(cascadesQuery.error),
                  onRetry: () => void cascadesQuery.refetch(),
                }
              : cascadesQuery.isLoading
                ? { kind: 'loading' }
                : { kind: 'blank', onCreate: () => navigate('/nodes/cascades/new') }
          }
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {/* The list itself: one component, two densities. The explainer strip
          that used to sit here is gone: the cards say what a cascade is by
          drawing one, and the action lives in the page bar. */}
      {/* A list that explains the cards (squads, policies, bindings, outbounds)
          did not arrive: said once here, the cards show a dash for it. */}
      {sideFailure && <LoadFailedLine message={sideFailure.message} onRetry={sideFailure.onRetry} />}
      <CascadesView
        rows={rows}
        layout={layout}
        onEdit={(c) => navigate(`/nodes/cascades/${c.id}`)}
        onDelete={(c) => confirmCascadeDelete(c, t, () => deleteMutation.mutate(c.id))}
        onToggleEnabled={(c) => enableMutation.mutate(c)}
        toggling={pendingId}
        refusals={refusals}
      />
    </Stack>
  );
}
