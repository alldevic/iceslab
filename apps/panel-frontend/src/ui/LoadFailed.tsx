import { useTranslation } from 'react-i18next';
import { Box, Text, UnstyledButton } from '@mantine/core';
import { CARD, CYAN, EDGE, HAIRLINE, MIST, RED, SNOW, WELL } from '@/lib/ui/tokens';

const DISPLAY = "'Inter Variable', Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/**
 * A request that did not answer, in place of the screen it feeds (A-141): the
 * server's words and a retry. Not «loading» forever, and not «there is none».
 */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: 40,
        borderRadius: 10,
        backgroundColor: CARD,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: RED }}>{t('common.loadFailed')}</Text>
      <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: MIST, textAlign: 'center', maxWidth: 560 }}>
        {message}
      </Text>
      <UnstyledButton
        type="button"
        onClick={onRetry}
        style={{ height: 32, paddingInline: 14, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${EDGE}` }}
      >
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, fontWeight: 500, color: SNOW }}>
          <span style={{ color: CYAN }}>↻ </span>
          {t('common.loadRetry')}
        </Text>
      </UnstyledButton>
    </Box>
  );
}
