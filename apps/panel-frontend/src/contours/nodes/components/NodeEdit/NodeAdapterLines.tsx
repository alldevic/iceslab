import { useTranslation } from 'react-i18next';
import { Stack, Text } from '@mantine/core';
import type { NodeSyncStatus } from '@/lib/domain/nodes';
import { slotConflictsOf, slotLabel, userScopeGapsOf } from '@/contours/nodes/lib/nodeAdapterFacts';
import { AMBER } from '@/contours/nodes/lib/colors';

/**
 * What the node's adapters do that the operator would not guess, from the
 * sync status: profiles sharing a single-inbound adapter (A-195), and where a
 * squad's limit on a user does not hold (A-204, the squad screen's words).
 * Drawn whether or not the config has landed: these are facts of the node,
 * not of the push. A server without the fields says nothing here.
 */
export function NodeAdapterLines({ status }: { status: NodeSyncStatus | undefined }) {
  const { t } = useTranslation();
  const conflicts = slotConflictsOf(status?.slotConflicts) ?? [];
  const gaps = userScopeGapsOf(status?.userScopeGaps) ?? [];
  if (conflicts.length === 0 && gaps.length === 0) return null;
  const at = (s: { profileName: string; port: number }) => `${s.profileName} :${s.port}`;
  const line = { fontSize: 12, lineHeight: '17px', color: AMBER } as const;
  return (
    <Stack gap={6} style={{ padding: '12px 16px', borderRadius: 10, backgroundColor: `${AMBER}0D`, border: `1px solid ${AMBER}33` }}>
      {conflicts.map((c) => (
        <Text key={`slot-${c.protocol}-${c.engine}`} style={line}>
          {t(c.served ? 'nodeEdit.slotConflict' : 'nodeEdit.slotConflictNoServed', {
            slot: slotLabel(c.protocol, c.engine, t),
            served: c.served ? at(c.served) : '',
            others: c.others.map(at).join(', '),
          })}
        </Text>
      ))}
      {gaps.map((g) => (
        <Text key={`gap-${g.profileName}-${g.port}`} style={line}>
          {t('nodeEdit.scopeGapLine', { profile: at(g), words: t(`squadEdit.scopeGap.${g.gap}`) })}
        </Text>
      ))}
    </Stack>
  );
}
