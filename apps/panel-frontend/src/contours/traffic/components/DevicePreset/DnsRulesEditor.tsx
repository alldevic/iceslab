import { MAX_DNS_RULES, MAX_DNS_RULE_NAMES } from '@iceslab/shared';
import { Box, Text, TextInput, UnstyledButton } from '@mantine/core';
import { DIM, DISPLAY, EDGE, FAINT, HAIRLINE, MIST, MONO, RED, SNOW, WELL } from '@/contours/traffic/lib/colors';
import { IconAction } from '@/contours/traffic/components/RoutePolicy/IconAction';
import { PlusIcon, TrashIcon } from '@/contours/traffic/components/RoutePolicy/icons';
import { checkDnsDrafts, type DnsRefused, type DnsRuleDraft } from '@/contours/traffic/lib/dnsRules';
import { splitMatch } from '@/contours/traffic/lib/routeRules';
import { useTranslation } from 'react-i18next';

const FIELD = {
  fontSize: 12,
  height: 34,
  minHeight: 34,
  borderRadius: 6,
  paddingInline: 10,
  backgroundColor: WELL,
  color: SNOW,
};

/**
 * "These names go to this DNS server": the rows of a preset's `dnsRules` and of
 * the panel-wide `subscriptionDnsRules`, one component for both. A row is
 * checked here before anything is sent (the names, the server, the limits) and
 * marked again where the API refused it. Which formats carry the rule is not
 * said per row but by the table of formats beside it (DnsFormatsTable).
 */
export function DnsRulesEditor({
  rows,
  onChange,
  refused,
  onTouch,
}: {
  rows: DnsRuleDraft[];
  onChange: (next: DnsRuleDraft[]) => void;
  refused: DnsRefused;
  /** The operator changed something: the marks of the last refusal are stale. */
  onTouch?: () => void;
}) {
  const { t } = useTranslation();
  const check = checkDnsDrafts(rows);
  const set = (i: number, patch: Partial<DnsRuleDraft>) => {
    onTouch?.();
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  return (
    <Box>
      {rows.length === 0 && (
        <Box style={{ paddingBlock: 6, paddingInline: 24 }}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: MIST }}>{t('routes.dnsRulesNone')}</Text>
        </Box>
      )}
      {rows.map((row, i) => {
        const problem = check.rows[i]!;
        const names = splitMatch(row.match);
        const badNames = [...new Set([...problem.badNames, ...names.filter((n) => refused.names.includes(n))])];
        const badServer = problem.badServer || (row.server.trim() !== '' && refused.servers.includes(row.server.trim()));
        const message = [
          badNames.length > 0 ? t('routes.dnsRuleBadNames', { entries: badNames.join(', ') }) : null,
          badServer ? t('routes.dnsRuleBadServer', { entry: row.server.trim() }) : null,
          problem.tooManyNames ? t('routes.dnsRuleTooManyNames', { max: MAX_DNS_RULE_NAMES }) : null,
          problem.incomplete && badNames.length === 0 && !badServer ? t('routes.dnsRuleIncomplete') : null,
        ].filter(Boolean);
        return (
          <Box key={i}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingBlock: 6, paddingInline: 24 }}>
              <TextInput
                style={{ flex: '2 1 220px', minWidth: 0 }}
                value={row.match}
                aria-label={t('routes.dnsRuleNames')}
                placeholder={t('routes.dnsRuleNamesPlaceholder')}
                onChange={(e) => set(i, { match: e.currentTarget.value })}
                styles={{ input: { ...FIELD, fontFamily: MONO, borderColor: badNames.length > 0 || problem.tooManyNames ? RED : HAIRLINE } }}
              />
              <TextInput
                style={{ flex: '1 1 200px', minWidth: 0 }}
                value={row.server}
                aria-label={t('routes.dnsRuleServer')}
                placeholder={t('routes.dnsRuleServerPlaceholder')}
                onChange={(e) => set(i, { server: e.currentTarget.value })}
                styles={{ input: { ...FIELD, fontFamily: MONO, borderColor: badServer ? RED : HAIRLINE } }}
              />
              <TextInput
                style={{ flex: '1 1 160px', minWidth: 0 }}
                value={row.note}
                aria-label={t('routes.dnsRuleNote')}
                placeholder={t('routes.notePlaceholder')}
                maxLength={200}
                onChange={(e) => set(i, { note: e.currentTarget.value })}
                styles={{ input: { ...FIELD, fontFamily: DISPLAY, borderColor: 'transparent', backgroundColor: 'transparent', color: FAINT } }}
              />
              <IconAction
                title={t('common.delete')}
                onClick={() => {
                  onTouch?.();
                  onChange(rows.filter((_, j) => j !== i));
                }}
              >
                <TrashIcon size={14} color={DIM} />
              </IconAction>
            </Box>
            {message.length > 0 && (
              <Text role="alert" style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: RED, padding: '0 24px 8px 24px' }}>
                {message.join(' ')}
              </Text>
            )}
          </Box>
        );
      })}
      {check.tooManyRules && (
        <Text role="alert" style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: RED, padding: '0 24px 8px 24px' }}>
          {t('routes.dnsRulesTooMany', { max: MAX_DNS_RULES })}
        </Text>
      )}
      <Box style={{ paddingTop: 8, paddingBottom: 14, paddingInline: 24 }}>
        <UnstyledButton
          type="button"
          onClick={() => {
            onTouch?.();
            onChange([...rows, { match: '', server: '', note: '' }]);
          }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBlock: 8, paddingInline: 14, borderRadius: 6, border: `1px dashed ${EDGE}` }}
        >
          <PlusIcon size={10} color={MIST} />
          <Text style={{ fontFamily: DISPLAY, fontSize: 13, lineHeight: '16px', color: MIST }}>{t('routes.dnsRuleAdd')}</Text>
        </UnstyledButton>
      </Box>
    </Box>
  );
}
