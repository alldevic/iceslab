import { useTranslation } from 'react-i18next';
import { Box, Text } from '@mantine/core';
import { PlainButton } from '@/contours/nodes/components/NodeEdit/PlainButton';
import { TickIcon, WarnIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { certPageView, certRotateRefusal, type CertTerm } from '@/contours/nodes/lib/nodeCert';
import { AMBER, DISPLAY, FAINT, MIST, MONO, MOSS, RED, SNOW } from '@/contours/nodes/lib/colors';

/**
 * The node's mTLS certificate on the node page (A-124): how long it lasts and
 * a renewal on request. What to say is certTerm's; here are the words and the
 * paint. Unknown is grey, not red: an agent older than rotation says nothing,
 * and that is not an expired pair.
 */
export function CertRow({
  term,
  agentCanRotate,
  onRotate,
  rotating,
  rotated,
  error,
}: {
  term: CertTerm;
  /** A-221: false = the agent cannot renew, no button (certPageView). */
  agentCanRotate: unknown;
  onRotate: () => void;
  rotating: boolean;
  /** The new end after a renewal in this visit. */
  rotated: string | null;
  error: unknown;
}) {
  const { t } = useTranslation();
  const value =
    term.kind === 'unknown'
      ? t('nodeEdit.cert.unknown')
      : term.kind === 'expired'
        ? t('nodeEdit.cert.expired', { date: fmtDate(term.notAfter), n: term.daysAgo })
        : t('nodeEdit.cert.until', { date: fmtDate(term.notAfter), n: term.days });
  const tone = term.kind === 'expired' ? RED : term.kind === 'soon' ? AMBER : term.kind === 'unknown' ? FAINT : SNOW;
  const refusal = certRotateRefusal(error);
  const view = certPageView(term, agentCanRotate);

  return (
    <>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: MIST, flex: 1, minWidth: 0 }}>
          {t('nodeEdit.cert.label')}
        </Text>
        <Text style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, lineHeight: '15px', color: tone }}>{value}</Text>
        {view.button && (
          <PlainButton icon="key" strong height={30} disabled={rotating} onClick={onRotate}>
            {t('nodeEdit.cert.rotate')}
          </PlainButton>
        )}
      </Box>
      {view.oldAgent && term.kind !== 'unknown' && (
        <Note
          tone={term.kind === 'ok' ? AMBER : RED}
          text={t('nodeEdit.cert.oldAgent', { date: fmtDate(term.notAfter) })}
        />
      )}
      {view.hint === 'soon' && term.kind === 'soon' && (
        <Note tone={AMBER} text={t('nodeEdit.cert.soonHint', { n: term.days })} />
      )}
      {view.hint === 'expired' && <Note tone={RED} text={t('nodeEdit.cert.expiredHint')} />}
      {rotated && !refusal && <Note tone={MOSS} ok text={t('nodeEdit.cert.rotated', { date: fmtDate(rotated) })} />}
      {refusal && (
        <Note
          tone={refusal.code === 'CERT_PENDING' ? AMBER : RED}
          text={t(`nodeEdit.cert.refusal.${refusal.code}`)}
          detail={refusal.detail}
        />
      )}
    </>
  );
}

function Note({ tone, text, detail, ok }: { tone: string; text: string; detail?: string; ok?: boolean }) {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '9px 12px',
        borderRadius: 8,
        backgroundColor: `${tone}0F`,
        border: `1px solid ${tone}2E`,
        width: '100%',
      }}
    >
      <Box style={{ paddingTop: 1, flexShrink: 0 }}>
        {ok ? <TickIcon size={13} color={tone} /> : <WarnIcon size={13} color={tone} />}
      </Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: tone }}>{text}</Text>
        {detail && (
          <Text style={{ fontFamily: MONO, fontSize: 10, lineHeight: '14px', color: MIST, wordBreak: 'break-word' }}>
            {detail}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
}
