import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Box, Stack, Text } from '@mantine/core';
import { Caption } from '@/contours/nodes/components/NodeEdit/Caption';
import { AMBER, CYAN, HAIRLINE, MIST, MONO, SNOW, WELL } from '@/contours/nodes/lib/colors';
import { listRoutingPresets } from '@/lib/domain/routePolicies';
import type { CarriedDnsSource, DeferredDnsEntry } from '@/lib/domain/nodes';
import { deferredReason } from '@/contours/nodes/lib/deferredDns';

/**
 * The DNS rules this node carries from presets and from the panel-wide rules
 * (19.12): read only, apart from the manual servers above, with the preset
 * they come from. They are edited there, not here. A rule whose names the
 * manual DNS also names is marked: the manual server answers first.
 *
 * 19.15: under them, what did NOT reach the node (`deferred`): a rule left out
 * because another preset names the same name with another server, or a preset
 * left out whole by the limit of 16 servers, each with the reason and a link to
 * the preset. Neither carried nor deferred: no block at all.
 */
export function CarriedDns({ carried, deferred }: { carried: CarriedDnsSource[] | undefined; deferred?: DeferredDnsEntry[] }) {
  const { t } = useTranslation();
  const sources = (carried ?? []).filter((s) => s.rules.length > 0);
  const left = deferred ?? [];
  const named = sources.some((s) => s.presetId !== null) || left.some((d) => d.presetId !== null || d.kind === 'conflict');
  const presets = useQuery({ queryKey: ['routing-presets'], queryFn: listRoutingPresets, enabled: named });
  if (sources.length === 0 && left.length === 0) return null;
  const nameOf = (id: string) => presets.data?.presets.find((p) => p.id === id)?.name ?? t('nodeEdit.dnsCarriedPresetUnknown');
  const presetLink = (id: string) => (
    <Link to={`/subscription/routes?preset=${encodeURIComponent(id)}`} style={{ fontSize: 12, color: CYAN, textDecoration: 'underline', textUnderlineOffset: 2 }}>
      {nameOf(id)}
    </Link>
  );

  return (
    <Stack gap={10} data-testid="carried-dns">
      {sources.length > 0 && <Caption>{t('nodeEdit.dnsCarriedTitle')}</Caption>}
      {sources.length > 0 && <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsCarriedIntro')}</Text>}
      {sources.map((s) => (
        <Stack key={s.presetId ?? 'panel'} gap={6} style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}>
          <Box style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            {s.presetId === null ? (
              <Text style={{ fontSize: 12, color: SNOW }}>{t('nodeEdit.dnsCarriedPanel')}</Text>
            ) : (
              presetLink(s.presetId)
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
      {left.length > 0 && (
        <Stack gap={6} data-testid="deferred-dns">
          <Caption>{t('nodeEdit.dnsDeferredTitle')}</Caption>
          <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsDeferredIntro')}</Text>
          {left.map((d, i) => (
            <Stack key={i} gap={2} style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}>
              <Box style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                {d.presetId === null ? (
                  <Text style={{ fontSize: 12, color: SNOW }}>{t('nodeEdit.dnsCarriedPanel')}</Text>
                ) : (
                  presetLink(d.presetId)
                )}
              </Box>
              <Text style={{ fontSize: 11, lineHeight: '15px', color: AMBER }}>
                {deferredReason(d, (id) => (id === null ? t('nodeEdit.dnsCarriedPanel') : nameOf(id)), t)}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
