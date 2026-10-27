import { useTranslation } from 'react-i18next';
import { Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { getPolicyDrawing, type NodePolicy } from '@/lib/domain/nodePolicies';
import { apiErrorMessage } from '@/lib/net/client';
import { relativeTime } from '@/lib/ui/relativeTime';
import { useNow } from '@/lib/ui/useNow';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { notDrawnReasonKey, policyDrawingLoad, policyDrawingView, type RuleRef } from '@/contours/nodes/lib/policyDrawing';
import { AMBER, MIST, RED } from '@/contours/nodes/lib/colors';

/**
 * Which rules of the node's saved policy reach the node (A-232), by the
 * drawing the panel SENDS, and beside it what the node's xray reports it drew.
 * The agent's silence is said as silence, never as «everything goes out»;
 * the request's own states each in their words (policyDrawingLoad).
 */
export function PolicyDrawingLines({ nodeId, policy }: { nodeId: string; policy: NodePolicy | undefined }) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const q = useQuery({
    queryKey: ['policy-drawing', nodeId],
    queryFn: () => getPolicyDrawing(nodeId),
    retry: false,
  });
  const line = (text: string, color = MIST) => (
    <Text style={{ fontSize: 12, lineHeight: '17px', color }}>{text}</Text>
  );
  const load = policyDrawingLoad(q, apiErrorMessage);
  if (load.kind === 'checking') return line(t('nodeEdit.policyDrawing.checking'));
  if (load.kind === 'old-server') return line(t('nodeEdit.policyDrawing.oldServer'));
  if (load.kind === 'failed') {
    return <LoadFailedLine message={`${t('nodeEdit.policyDrawing.failed')}: ${load.message}`} onRetry={load.onRetry} />;
  }
  if (load.kind === 'unknown') return line(t('nodeEdit.policyDrawing.unknown'));
  const parsed = load.drawing;
  if (parsed.policyId === null) return null;
  const v = policyDrawingView(parsed, policy?.rules, now);
  const name = (r: RuleRef) => r.label ?? r.ruleId.slice(0, 8);
  const reason = (code: string) => {
    const key = notDrawnReasonKey(code);
    return key ? t(key) : code;
  };
  return (
    <Stack gap={4}>
      {line(t('nodeEdit.policyDrawing.bySent', { drawing: v.sent }))}
      {v.panelNotDrawn.length === 0
        ? line(t('nodeEdit.policyDrawing.allSent'))
        : v.panelNotDrawn.map((r) =>
            <Text key={`p-${r.ruleId}`} style={{ fontSize: 12, lineHeight: '17px', color: AMBER }}>
              {t('nodeEdit.policyDrawing.notSent', { rule: name(r), reason: reason(r.reason) })}
            </Text>,
          )}
      {v.agent === null ? (
        line(t('nodeEdit.policyDrawing.agentSilent'))
      ) : (
        <>
          {v.agent.mismatch &&
            line(t('nodeEdit.policyDrawing.mismatch', { sent: v.sent, drawn: v.agent.drawing }), RED)}
          {v.agent.notDrawn.map((r) => (
            <Text key={`a-${r.ruleId}`} style={{ fontSize: 12, lineHeight: '17px', color: RED }}>
              {t('nodeEdit.policyDrawing.agentNotDrawn', { rule: name(r) })}
            </Text>
          ))}
          {v.agent.orphanExits.map((e) => (
            <Text key={`o-${e.exit}`} style={{ fontSize: 12, lineHeight: '17px', color: AMBER }}>
              {t('nodeEdit.policyDrawing.orphanExit', { direction: e.direction, exit: e.exit })}
            </Text>
          ))}
          {!v.agent.mismatch && v.agent.notDrawn.length === 0 && v.agent.orphanExits.length === 0 &&
            line(t('nodeEdit.policyDrawing.agentAgrees', { drawing: v.agent.drawing }))}
          {line(
            t('nodeEdit.policyDrawing.times', {
              rendered: relativeTime(v.agent.renderedAt, t).text,
              observed: relativeTime(v.agent.observedAt, t).text,
            }),
            v.agent.stale ? AMBER : MIST,
          )}
          {v.agent.stale && line(t('nodeEdit.policyDrawing.stale'), AMBER)}
        </>
      )}
    </Stack>
  );
}
