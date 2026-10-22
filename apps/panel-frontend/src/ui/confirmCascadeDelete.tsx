import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { TFunction } from 'i18next';
import { cascadeMembers } from '@/lib/domain/cascadeMembership';
import type { Cascade } from '@/lib/domain/cascades';

/**
 * The one window that stands before a cascade delete, wherever it is pressed:
 * the list and the edit page ask the same question. A delete takes the legs'
 * keys and tunnels with it, so it is never one click (P7).
 *
 * Nodes are counted by positions and directions (cascadeMembers): a v4 cascade
 * has `hops: []` and used to ask «delete a cascade of 0 nodes» (A-141).
 */
export function confirmCascadeDelete(
  cascade: Pick<Cascade, 'name'> & Parameters<typeof cascadeMembers>[0],
  t: TFunction,
  onConfirm: () => void,
): void {
  modals.openConfirmModal({
    title: t('cascadeEdit.deleteTitle', { name: cascade.name }),
    children: <Text size="sm">{t('cascadeEdit.deleteBody', { count: cascadeMembers(cascade).length })}</Text>,
    labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}
