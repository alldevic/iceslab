import { Box, Text, UnstyledButton } from '@mantine/core';
import { CYAN, DISPLAY, FAINT, MIST, MONO, SNOW } from '@/contours/traffic/lib/colors';
import { apiErrorMessage } from '@/lib/net/client';
import { getSettings } from '@/lib/domain/settings';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

/** The anchor OwnRules carries, so a built-in preset can point at where its extra rules are edited. */
export const OWN_RULES_ANCHOR = 'own-rules';

/**
 * The panel-wide DNS rules as they apply to a built-in preset: read only, with
 * a way to the place they are written (the own rules, lower on this screen).
 */
export function PanelDnsRules() {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ['settings', 'all'], queryFn: getSettings });
  const rules = settings.data?.subscriptionDnsRules ?? [];
  return (
    <Box style={{ paddingBlock: 12, paddingInline: 24 }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: MIST }}>
          {t('routes.panelDnsTitle')}
        </Text>
        <UnstyledButton
          type="button"
          onClick={() => document.getElementById(OWN_RULES_ANCHOR)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
        >
          <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: CYAN }}>{t('routes.panelDnsEdit')}</Text>
        </UnstyledButton>
      </Box>
      {settings.isError ? (
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: FAINT, marginTop: 6 }}>{apiErrorMessage(settings.error)}</Text>
      ) : rules.length === 0 ? (
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: FAINT, marginTop: 6 }}>{t('routes.panelDnsNone')}</Text>
      ) : (
        rules.map((r, i) => (
          <Box key={i} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
            <Text style={{ fontFamily: MONO, fontSize: 12, color: SNOW }}>{r.match.join(' · ')}</Text>
            <Text style={{ fontFamily: MONO, fontSize: 12, color: SNOW }}>→ {r.server}</Text>
            {r.note && <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: FAINT }}>{r.note}</Text>}
          </Box>
        ))
      )}
    </Box>
  );
}
