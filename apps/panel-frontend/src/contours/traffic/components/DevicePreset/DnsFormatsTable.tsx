import { Box, Text } from '@mantine/core';
import { AMBER, DISPLAY, FAINT, HAIRLINE, MIST, MONO, MOSS, RED, SNOW } from '@/contours/traffic/lib/colors';
import { DNS_FORMATS, type DnsFormatNote } from '@/contours/traffic/lib/dnsFormats';
import { useTranslation } from 'react-i18next';

function noteWords(note: DnsFormatNote, t: (key: string) => string): string {
  switch (note) {
    case 'xray':
      return t('routes.dnsFormat.note.xray');
    case 'xrayApps':
      return t('routes.dnsFormat.note.xrayApps');
    case 'xkeen':
      return t('routes.dnsFormat.note.xkeen');
    case 'mihomo':
      return t('routes.dnsFormat.note.mihomo');
    case 'noGroup':
      return t('routes.dnsFormat.note.noGroup');
    case 'wg':
      return t('routes.dnsFormat.note.wg');
    case 'noSection':
      return t('routes.dnsFormat.note.noSection');
  }
}

const KIND_LABEL = { udp: 'UDP', tcp: 'TCP', tls: 'DoT', https: 'DoH' } as const;

const CELL = { fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px' } as const;
const HEAD = { fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: MIST } as const;
const COLS = '150px 110px 190px minmax(0, 1fr)';

/**
 * Which subscription formats run a DNS rule, always on screen under the
 * editor, whatever is typed in it (the data is DNS_FORMATS, a constant).
 * Saving never waits on it: a rule is saved whichever formats are switched on.
 */
export function DnsFormatsTable() {
  const { t } = useTranslation();
  return (
    <Box style={{ paddingBlock: 12, paddingInline: 24, borderTop: `1px solid ${HAIRLINE}` }}>
      <Text style={{ ...HEAD, marginBottom: 4 }}>{t('routes.dnsFormat.title')}</Text>
      <Text style={{ ...CELL, fontSize: 11, color: FAINT, marginBottom: 8 }}>{t('routes.dnsFormat.hint')}</Text>
      <Box role="table" aria-label={t('routes.dnsFormat.title')} style={{ overflowX: 'auto' }}>
        <Box role="row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, paddingBlock: 6, minWidth: 560 }}>
          <Text role="columnheader" style={HEAD}>{t('routes.dnsFormat.colFormat')}</Text>
          <Text role="columnheader" style={HEAD}>{t('routes.dnsFormat.colRuns')}</Text>
          <Text role="columnheader" style={HEAD}>{t('routes.dnsFormat.colKinds')}</Text>
          <Text role="columnheader" style={HEAD}>{t('routes.dnsFormat.colNote')}</Text>
        </Box>
        {DNS_FORMATS.map((f) => {
          const kinds =
            f.kinds === null
              ? '—'
              : f.kinds === 'unverified'
                ? t('routes.dnsFormat.unverified')
                : f.kinds.map((k) => KIND_LABEL[k]).join(', ');
          const notes = [f.note ? noteWords(f.note, t) : null, f.soon ? t('routes.dnsFormat.soon') : null].filter(Boolean);
          return (
            <Box key={f.id} role="row" data-format={f.id} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, paddingBlock: 5, minWidth: 560, borderTop: `1px solid ${HAIRLINE}` }}>
              <Text role="cell" style={{ ...CELL, fontFamily: MONO, color: SNOW }}>{f.label}</Text>
              <Text role="cell" style={{ ...CELL, color: f.runs ? MOSS : RED }}>{f.runs ? t('routes.dnsFormat.yes') : t('routes.dnsFormat.no')}</Text>
              <Text role="cell" style={{ ...CELL, color: f.kinds === 'unverified' ? AMBER : SNOW }}>{kinds}</Text>
              <Text role="cell" style={{ ...CELL, color: FAINT }}>{notes.join(' ')}</Text>
            </Box>
          );
        })}
      </Box>
      <Text style={{ ...CELL, fontSize: 11, color: MIST, marginTop: 8 }}>{t('routes.dnsFormat.ownDns')}</Text>
    </Box>
  );
}
