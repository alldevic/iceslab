import { useTranslation } from 'react-i18next';
import { Box, Stack, Text } from '@mantine/core';
import { dnsReach } from '@/lib/domain/dnsReach';
import type { NodeCore } from '@/lib/domain/nodes';
import { AMBER, MIST, MONO, RED, SNOW } from '@/contours/nodes/lib/colors';

/**
 * Who on this node executes the DNS setting, by core. Counterpart of
 * `PolicyReach`: the answer is about cores, so it is a list of them and never
 * one word about the node. A core that did not answer is listed apart and is
 * not folded into «no».
 */
export function DnsReach({ cores }: { cores: NodeCore[] | null | undefined }) {
  const { t } = useTranslation();
  const { state, executing, notExecuting, unknown } = dnsReach(cores);
  const list = (names: string[]) => names.join(', ');

  const unknownLine = unknown.length > 0 && (
    <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>
      {t('nodeEdit.dnsReachSomeUnknown', { cores: list(unknown) })}
    </Text>
  );

  if (state === 'unknown') {
    return (
      <Stack gap={4}>
        <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsReachUnknown')}</Text>
        {cores && cores.length > 0 && unknownLine}
      </Stack>
    );
  }

  if (notExecuting.length === 0) {
    return (
      <Stack gap={4}>
        <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>
          {t('nodeEdit.dnsReachAll', { cores: list(executing) })}
        </Text>
        {unknownLine}
      </Stack>
    );
  }

  const none = state === 'not-executes';
  const tone = none ? RED : AMBER;
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: '100%',
        padding: '14px 16px',
        borderRadius: 10,
        backgroundColor: `${tone}0F`,
        border: `1px solid ${tone}33`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Box style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: tone, flexShrink: 0 }} />
        <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.14em', color: tone }}>
          {none ? t('nodeEdit.dnsReachNoneTag') : t('nodeEdit.dnsReachSomeTag')}
        </Text>
      </Box>
      <Stack gap={4}>
        <Text style={{ fontSize: 13, lineHeight: '19px', color: SNOW }}>
          {none
            ? t('nodeEdit.dnsReachNone', { cores: list(notExecuting) })
            : t('nodeEdit.dnsReachSome', { executing: list(executing), missing: list(notExecuting) })}
        </Text>
        {unknownLine}
      </Stack>
    </Box>
  );
}
