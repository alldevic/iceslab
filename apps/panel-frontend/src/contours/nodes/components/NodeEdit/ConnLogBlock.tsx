import { useTranslation } from 'react-i18next';
import { Box, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnLogSource } from '@iceslab/shared';
import { clearConnLog, connLogClearOf, connLogRefusal, connLogTraceOf, getConnLog } from '@/lib/domain/connLog';
import { connLogClearFailures, connLogView, type ConnLogLine } from '@/contours/nodes/lib/connLogView';
import { confirmConnLogClear } from '@/contours/nodes/components/nodeConfirm';
import { PlainButton } from '@/contours/nodes/components/NodeEdit/PlainButton';
import { apiErrorMessage } from '@/lib/net/client';
import { AMBER, DISPLAY, FAINT, MIST, MONO, MOSS, RED, SNOW } from '@/contours/nodes/lib/colors';

/**
 * «Connection log» on the node page (owner's decision 26.10): whether the
 * machine's journal or syslog holds clients' addresses, and a wipe of both.
 *
 * The check is heavy (up to a minute on the node), so it runs on the
 * operator's «Check», never on a render of the page; the wipe takes up to two
 * minutes, and both say they are running while they do. Refusals in words:
 * an agent older than the route says «update the agent», as the certificate
 * row does.
 */
export function ConnLogBlock({ node }: { node: { id: string; name: string } }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ['conn-log', node.id];
  const q = useQuery({ queryKey: key, queryFn: () => getConnLog(node.id), enabled: false, retry: false, staleTime: Infinity });
  const clear = useMutation({
    mutationFn: () => clearConnLog(node.id),
    onSuccess: (data) => {
      const parsed = connLogClearOf(data);
      // After the wipe the node checked again: that answer is the block's now.
      if (parsed) qc.setQueryData(key, parsed.after);
    },
  });

  // A failed re-check keeps the old answer in the cache: it is not drawn as now.
  const trace = q.data === undefined || q.isError ? null : connLogTraceOf(q.data);
  const view = trace ? connLogView(trace) : null;
  const refusal = connLogRefusal(q.error) ?? connLogRefusal(clear.error);
  const cleared = clear.data !== undefined ? connLogClearOf(clear.data) : null;
  const failures = cleared ? connLogClearFailures(cleared) : [];
  const busy = q.isFetching || clear.isPending;
  const date = (iso: string | null) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
  };
  const sourceName = (s: ConnLogSource) => t(`nodeEdit.connLog.source.${s}`);
  const lineText = (l: ConnLogLine) =>
    l.state === 'found'
      ? t('nodeEdit.connLog.line.found', { source: sourceName(l.source), date: date(l.since) })
      : l.state === 'clean'
        ? t('nodeEdit.connLog.line.clean', { source: sourceName(l.source) })
        : l.state === 'absent'
          ? t(`nodeEdit.connLog.line.absent.${l.source}`)
          : t('nodeEdit.connLog.line.failed', { source: sourceName(l.source), error: l.error ?? '-' });

  const value = q.isFetching
    ? t('nodeEdit.connLog.checking')
    : clear.isPending
      ? t('nodeEdit.connLog.clearing')
      : refusal?.kind === 'update-agent'
        ? t('nodeEdit.connLog.updateAgent')
        : view
          ? view.headline.kind === 'present'
            ? t('nodeEdit.connLog.present', { date: date(view.headline.since) })
            : view.headline.kind === 'none'
              ? t('nodeEdit.connLog.none')
              : t('nodeEdit.connLog.unknown')
          : q.data !== undefined
            ? t('nodeEdit.connLog.unreadable')
            : t('nodeEdit.connLog.notChecked');
  const tone =
    refusal?.kind === 'update-agent' || view?.headline.kind === 'unknown'
      ? AMBER
      : view?.headline.kind === 'present'
        ? RED
        : view?.headline.kind === 'none'
          ? MOSS
          : FAINT;
  const otherError = (q.error && !connLogRefusal(q.error)) || (clear.error && !connLogRefusal(clear.error));

  return (
    <>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: MIST, flex: 1, minWidth: 0 }}>
          {t('nodeEdit.connLog.label')}
        </Text>
        <Text style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, lineHeight: '15px', color: tone }}>{value}</Text>
        <PlainButton
          icon="shield"
          height={30}
          disabled={busy}
          onClick={() => {
            // A new check answers anew: the last wipe's lines were about then.
            clear.reset();
            void q.refetch();
          }}
        >
          {t('nodeEdit.connLog.check')}
        </PlainButton>
        {view?.canClear && (
          <PlainButton strong height={30} disabled={busy} onClick={() => confirmConnLogClear(node, t, () => clear.mutate())}>
            {t('nodeEdit.connLog.clear')}
          </PlainButton>
        )}
      </Box>
      {view && view.lines.length > 0 && (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
          {view.lines.map((l) => (
            <Text key={l.source} style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: l.state === 'failed' ? AMBER : l.state === 'found' ? SNOW : FAINT }}>
              {lineText(l)}
            </Text>
          ))}
        </Box>
      )}
      {cleared && failures.length === 0 && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: MOSS }}>{t('nodeEdit.connLog.clearedAll')}</Text>
      )}
      {failures.map((f, i) => (
        <Text key={i} style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: RED, wordBreak: 'break-word' }}>
          {f.command
            ? t('nodeEdit.connLog.stepFailed', { source: sourceName(f.source), command: f.command, error: f.error ?? '-' })
            : t('nodeEdit.connLog.sourceFailed', { source: sourceName(f.source) })}
        </Text>
      ))}
      {refusal?.kind === 'node-failed' && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: RED }}>
          {t('nodeEdit.connLog.nodeFailed', { message: refusal.message || '-' })}
        </Text>
      )}
      {refusal?.kind === 'not-found' && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: RED }}>{t('nodeEdit.connLog.notFound')}</Text>
      )}
      {otherError && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: RED }}>
          {apiErrorMessage(q.error ?? clear.error)}
        </Text>
      )}
    </>
  );
}
