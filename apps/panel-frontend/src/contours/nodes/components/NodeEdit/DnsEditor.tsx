import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { Caption } from '@/contours/nodes/components/NodeEdit/Caption';
import { CarriedDns } from '@/contours/nodes/components/NodeEdit/CarriedDns';
import { DnsReach } from '@/contours/nodes/components/NodeEdit/DnsReach';
import { PlainButton } from '@/contours/nodes/components/NodeEdit/PlainButton';
import { ServerIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { FIELD } from '@/contours/nodes/lib/fieldStyles';
import { CARD, CYAN, HAIRLINE, MIST, WELL } from '@/contours/nodes/lib/colors';
import {
  DNS_MAX_SERVERS,
  dnsHasAdvanced,
  dnsProblems,
  emptyDnsServer,
  type DnsForm,
  type DnsProblem,
  type DnsQueryStrategy,
  type DnsServerForm,
} from '@/contours/nodes/lib/nodeDnsForm';
import type { CarriedDnsSource, NodeCore } from '@/lib/domain/nodes';

/** Built-in resolvers of a node with no DNS of its own (core.DefaultResolvers in apps/node). */
const BUILT_IN = '1.1.1.1, 8.8.8.8, localhost';

/**
 * The node's DNS: servers with their domains, the query strategy, the cache.
 * It edits a slice of the node form, so it is saved by the page's Save and the
 * sync strip above reports the push like for every other field.
 */
export function DnsEditor({
  value,
  onChange,
  cores,
  carried,
}: {
  value: DnsForm;
  onChange: (next: DnsForm) => void;
  cores: NodeCore[] | null | undefined;
  /** What the node carries from presets (19.12), shown apart and read only. */
  carried?: CarriedDnsSource[];
}) {
  const { t } = useTranslation();
  // expectIps, strategy and cache stay folded unless the node already uses them.
  const [advanced, setAdvanced] = useState(() => dnsHasAdvanced(value));
  const problems = dnsProblems(value);
  const problemOf = (index: number | null, field: DnsProblem['field']): string | undefined => {
    const p = problems.find((x) => x.index === index && x.field === field);
    return p ? problemWords(p, t) : undefined;
  };

  const setServer = (i: number, patch: Partial<DnsServerForm>) =>
    onChange({ ...value, servers: value.servers.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const empty = value.servers.length === 0;

  return (
    <Stack
      gap={16}
      style={{ padding: 20, borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ServerIcon size={15} color={CYAN} />
        <Caption>{t('nodeEdit.dnsTitle')}</Caption>
      </Box>
      <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsIntro')}</Text>

      {empty && <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.dnsDefaultNote', { resolvers: BUILT_IN })}</Text>}

      {value.servers.map((s, i) => (
        <Stack
          key={i}
          gap={12}
          style={{ padding: 14, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Caption>{t('nodeEdit.dnsServerN', { n: i + 1 })}</Caption>
            <PlainButton height={30} onClick={() => onChange({ ...value, servers: value.servers.filter((_, j) => j !== i) })}>
              {t('nodeEdit.dnsRemoveServer')}
            </PlainButton>
          </Box>
          <TextInput
            {...FIELD}
            label={t('nodeEdit.dnsAddress')}
            description={t('nodeEdit.dnsAddressDesc')}
            placeholder="77.88.8.8"
            value={s.address}
            error={problemOf(i, 'address')}
            onChange={(e) => setServer(i, { address: e.currentTarget.value })}
          />
          <Textarea
            {...FIELD}
            label={t('nodeEdit.dnsDomains')}
            description={t('nodeEdit.dnsDomainsDesc')}
            placeholder="geosite:category-ru"
            autosize
            minRows={2}
            maxRows={8}
            value={s.domains}
            error={problemOf(i, 'domains')}
            onChange={(e) => setServer(i, { domains: e.currentTarget.value })}
          />
          <Switch
            label={t('nodeEdit.dnsSkipFallback')}
            description={t('nodeEdit.dnsSkipFallbackDesc')}
            checked={s.skipFallback}
            onChange={(e) => setServer(i, { skipFallback: e.currentTarget.checked })}
          />
          {advanced && (
            <Textarea
              {...FIELD}
              label={t('nodeEdit.dnsExpectIps')}
              description={t('nodeEdit.dnsExpectIpsDesc')}
              placeholder="geoip:ru"
              autosize
              minRows={1}
              maxRows={6}
              value={s.expectIps}
              error={problemOf(i, 'expectIps')}
              onChange={(e) => setServer(i, { expectIps: e.currentTarget.value })}
            />
          )}
        </Stack>
      ))}

      {problemOf(null, 'servers') && (
        <Text style={{ fontSize: 12, lineHeight: '17px', color: '#E07A5F' }}>{problemOf(null, 'servers')}</Text>
      )}

      {advanced && !empty && (
        <Box style={{ display: 'flex', alignItems: 'flex-start', gap: 20, width: '100%' }}>
          <Select
            {...FIELD}
            style={{ flex: 1, minWidth: 0 }}
            label={t('nodeEdit.dnsQueryStrategy')}
            description={t('nodeEdit.dnsQueryStrategyDesc')}
            data={[
              { value: '', label: t('nodeEdit.dnsQueryStrategyDefault') },
              { value: 'UseIP', label: 'UseIP' },
              { value: 'UseIPv4', label: 'UseIPv4' },
              { value: 'UseIPv6', label: 'UseIPv6' },
            ]}
            allowDeselect={false}
            value={value.queryStrategy}
            onChange={(v) => onChange({ ...value, queryStrategy: (v ?? '') as DnsQueryStrategy })}
          />
          <Box style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
            <Switch
              label={t('nodeEdit.dnsDisableCache')}
              description={t('nodeEdit.dnsDisableCacheDesc')}
              checked={value.disableCache}
              onChange={(e) => onChange({ ...value, disableCache: e.currentTarget.checked })}
            />
          </Box>
        </Box>
      )}

      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PlainButton
          icon="plus"
          height={34}
          disabled={value.servers.length >= DNS_MAX_SERVERS}
          onClick={() => onChange({ ...value, servers: [...value.servers, emptyDnsServer()] })}
        >
          {t('nodeEdit.dnsAddServer')}
        </PlainButton>
        <PlainButton height={34} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? t('nodeEdit.dnsAdvancedHide') : t('nodeEdit.dnsAdvanced')}
        </PlainButton>
        {/* Rows only: the unsaved reset shows in the page bar, and a stored
            setting is taken off the node by Save (the form sends dns: null). */}
        <PlainButton
          height={34}
          disabled={empty && value.queryStrategy === '' && !value.disableCache}
          onClick={() => onChange({ servers: [], queryStrategy: '', disableCache: false })}
        >
          {t('nodeEdit.dnsReset')}
        </PlainButton>
      </Box>

      <CarriedDns carried={carried} />

      <DnsReach cores={cores} />
    </Stack>
  );
}

/** The sentence for a problem. Literal keys, so the key checks can read them. */
function problemWords(p: DnsProblem, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const limit = { limit: p.limit };
  switch (`${p.field}.${p.code}`) {
    case 'servers.tooMany':
      return t('nodeEdit.dnsProblem.servers.tooMany', limit);
    case 'address.tooLong':
      return t('nodeEdit.dnsProblem.address.tooLong', limit);
    case 'domains.tooMany':
      return t('nodeEdit.dnsProblem.domains.tooMany', limit);
    case 'domains.tooLong':
      return t('nodeEdit.dnsProblem.domains.tooLong', limit);
    case 'expectIps.tooMany':
      return t('nodeEdit.dnsProblem.expectIps.tooMany', limit);
    case 'expectIps.tooLong':
      return t('nodeEdit.dnsProblem.expectIps.tooLong', limit);
    default:
      return t('nodeEdit.dnsProblem.address.required');
  }
}
