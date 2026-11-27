import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Box, Stack, Text } from '@mantine/core';
import { Caption } from '@/contours/nodes/components/NodeEdit/Caption';
import { AMBER, CYAN, HAIRLINE, MIST, MONO, SNOW, WELL } from '@/contours/nodes/lib/colors';
import { listRoutingPresets } from '@/lib/domain/routePolicies';
import type { CarriedDnsSource } from '@/lib/domain/nodes';

/**
 * The DNS rules this node carries from presets and from the panel-wide rules
 * (19.12): read only, apart from the manual servers above, with the preset
 * they come from. They are edited there, not here. A rule whose names the
 * manual DNS also names is marked: the manual server answers first.
 */
export function CarriedDns({ carried }: { carried: CarriedDnsSource[] | undefined }) {
  const { t } = useTranslation();
  const sources = (carried ?? []).filter((s) => s.rules.length > 0);
  const presets = useQuery({ queryKey: ['routing-presets'], queryFn: listRoutingPresets, enabled: sources.some((s) => s.presetId !== null) });
  if (sources.length === 0) return null;
  const nameOf = (id: string) => presets.data?.presets.find((p) => p.id === id)?.name ?? t('nodeEdit.dnsCarriedPresetUnknown');

  return (
    <Stack gap={10} data-testid="carried-dns">
      <Caption>{t('nodeEdit.dnsCarriedTitle')}</Caption>
      <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsCarriedIntro')}</Text>
      {sources.map((s) => (
        <Stack key={s.presetId ?? 'panel'} gap={6} style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}>
          <Box style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            {s.presetId === null ? (
              <Text style={{ fontSize: 12, color: SNOW }}>{t('nodeEdit.dnsCarriedPanel')}</Text>
            ) : (
              <Link to={`/subscription/routes?preset=${encodeURIComponent(s.presetId)}`} style={{ fontSize: 12, color: CYAN, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {nameOf(s.presetId)}
              </Link>
            )}
          </Box>
          {s.rules.map((r, i) => (
            <Box key={i}>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: SNOW }}>
                {r.match.join(' · ')} → {r.server}
              </Text>
              {r.overridden.length > 0 && (
                <Text style={{ fontSize: 11, lineHeight: '15px', color: AMBER }}>{t('nodeEdit.dnsCarriedOverridden', { names: r.overridden.join(', ') })}</Text>
              )}
            </Box>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
