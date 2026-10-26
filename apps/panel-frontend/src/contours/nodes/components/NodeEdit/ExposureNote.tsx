import { useTranslation } from 'react-i18next';
import { AMBER, DISPLAY, MIST, MOSS } from '@/contours/nodes/lib/colors';
import { Box, Text } from '@mantine/core';
import { TickIcon, WarnIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { exposureView } from '@/contours/nodes/lib/exposureView';

export function ExposureNote({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const v = exposureView(result);
  const clean = v.kind === 'clean';
  const tone = v.kind === 'skipped' ? MIST : clean ? MOSS : AMBER;
  const text =
    v.kind === 'skipped'
      ? t('nodeEdit.exposureSkipped', { note: v.note ?? '-' })
      : v.kind === 'clean'
        ? t('nodeEdit.exposureClean')
        : v.kind === 'extra'
          ? t('nodeEdit.exposureExtra', { ports: v.ports.join(', ') })
          : t('nodeEdit.exposureUnknown');
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 12px',
        borderRadius: 8,
        backgroundColor: `${tone}0F`,
        border: `1px solid ${tone}2E`,
        width: '100%',
      }}
    >
      {clean ? <TickIcon size={13} color={tone} /> : <WarnIcon size={13} color={tone} />}
      <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: tone, flex: 1 }}>{text}</Text>
    </Box>
  );
}
