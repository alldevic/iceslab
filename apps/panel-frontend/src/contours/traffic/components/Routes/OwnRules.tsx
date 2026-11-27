import { AMBER, CARD, CYAN, DISPLAY, FAINT, HAIRLINE, MIST, MONO, MOSS, RED, SNOW, WELL } from '@/contours/traffic/lib/colors';
import { Box, Stack, Text, Textarea } from '@mantine/core';
import { Bucket } from '@/contours/traffic/components/Routes/Bucket';
import { Caption, FieldLabel } from '@/contours/traffic/components/Routes/Labels';
import { PencilIcon } from '@/contours/traffic/components/Routes/icons';
import { SaveButton } from '@/contours/traffic/components/Routes/SaveButton';
import { Verdict } from '@/contours/traffic/components/Routes/Verdict';
import { apiErrorMessage } from '@/lib/net/client';
import { DnsFormatsTable } from '@/contours/traffic/components/DevicePreset/DnsFormatsTable';
import { DnsRulesEditor } from '@/contours/traffic/components/DevicePreset/DnsRulesEditor';
import { OWN_RULES_ANCHOR } from '@/contours/traffic/components/DevicePreset/PanelDnsRules';
import { checkDnsDrafts, dnsDrafts, dnsRefusedOf, dnsRulesOf, NO_DNS_REFUSED, type DnsRefused, type DnsRuleDraft } from '@/contours/traffic/lib/dnsRules';
import { presetRefusalWords } from '@/contours/traffic/lib/presetRefusal';
import { routingPresetRefusal } from '@/lib/domain/routePolicies';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { loadFailure } from '@/lib/ui/loadView';
import { getSettings, updateSettings } from '@/lib/domain/settings';
import { notifications } from '@mantine/notifications';
import { parseRules, splitLines } from '@/contours/traffic/lib/routeExchange';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
export function OwnRules() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['settings', 'all'], queryFn: getSettings });

  const [draft, setDraft] = useState<{ direct: string; proxy: string; block: string; rules: string; dns: DnsRuleDraft[] } | null>(
    null,
  );
  const [dnsRefused, setDnsRefused] = useState<DnsRefused>(NO_DNS_REFUSED);
  const [loaded, setLoaded] = useState(false);
  if (!loaded && settingsQuery.data) {
    setLoaded(true);
    const cdl = settingsQuery.data.subscriptionCustomDomainLists;
    setDraft({
      direct: (cdl?.direct ?? []).join('\n'),
      proxy: (cdl?.proxy ?? []).join('\n'),
      block: (cdl?.block ?? []).join('\n'),
      rules: settingsQuery.data.subscriptionCustomRoutingRules
        ? JSON.stringify(settingsQuery.data.subscriptionCustomRoutingRules, null, 2)
        : '',
      dns: dnsDrafts(settingsQuery.data.subscriptionDnsRules ?? []),
    });
  }

  const rulesState = useMemo(() => parseRules(draft?.rules ?? ''), [draft?.rules]);
  const saved = settingsQuery.data
    ? {
        direct: (settingsQuery.data.subscriptionCustomDomainLists?.direct ?? []).join('\n'),
        proxy: (settingsQuery.data.subscriptionCustomDomainLists?.proxy ?? []).join('\n'),
        block: (settingsQuery.data.subscriptionCustomDomainLists?.block ?? []).join('\n'),
        rules: settingsQuery.data.subscriptionCustomRoutingRules
          ? JSON.stringify(settingsQuery.data.subscriptionCustomRoutingRules, null, 2)
          : '',
        dns: dnsDrafts(settingsQuery.data.subscriptionDnsRules ?? []),
      }
    : null;
  // Compared as what would be sent, so a blank row added and left alone is not a change.
  const sent = (d: { direct: string; proxy: string; block: string; rules: string; dns: DnsRuleDraft[] }) => JSON.stringify({ ...d, dns: dnsRulesOf(d.dns) });
  const dirty = Boolean(draft && saved && sent(draft) !== sent(saved));
  const dnsBlocked = draft ? checkDnsDrafts(draft.dns).blocked : false;

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('nothing to save');
      const direct = splitLines(draft.direct);
      const proxy = splitLines(draft.proxy);
      const block = splitLines(draft.block);
      const empty = direct.length + proxy.length + block.length === 0;
      return updateSettings({
        // All three empty clears the setting, so subscription output stays
        // byte-identical to "no lists defined".
        subscriptionCustomDomainLists: empty ? null : { direct, proxy, block },
        subscriptionCustomRoutingRules: rulesState.rules,
        // Only when changed: a panel that never had DNS rules sends what it always sent.
        // No rows clears the setting, like the lists above.
        ...(saved && JSON.stringify(dnsRulesOf(draft.dns)) !== JSON.stringify(dnsRulesOf(saved.dns))
          ? { subscriptionDnsRules: dnsRulesOf(draft.dns).length === 0 ? null : dnsRulesOf(draft.dns) }
          : {}),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      setLoaded(false);
      notifications.show({ color: 'green', message: t('routes.ownSaved') });
    },
    onError: (err) => {
      // A refused DNS rule is said in words and marked in its row.
      const refusal = routingPresetRefusal(err);
      setDnsRefused(dnsRefusedOf(refusal));
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: refusal ? presetRefusalWords(refusal, t) : apiErrorMessage(err),
      });
    },
  });

  // A-228: settings that did not arrive are said with a retry; the section
  // used to vanish. While they are on their way there is nothing to draw yet.
  if (!draft) {
    const failure = loadFailure(settingsQuery, apiErrorMessage);
    return failure ? <LoadFailedLine message={failure.message} onRetry={failure.onRetry} /> : null;
  }
  const patch = (p: Partial<typeof draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <Stack
      id={OWN_RULES_ANCHOR}
      gap={16}
      style={{ padding: 20, borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
        <PencilIcon size={15} color={CYAN} />
        <Caption>{t('routes.ownTitle')}</Caption>
        <Text
          style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT, flex: 1, minWidth: 0 }}
        >
          {t('routes.ownHint')}
        </Text>
        <Verdict tone={rulesState.error ? RED : dirty ? AMBER : MIST}>
          {rulesState.error ? t(rulesState.error) : dirty ? t('routes.unsaved') : t('routes.saved')}
        </Verdict>
        <SaveButton
          disabled={!dirty || rulesState.error !== null || dnsBlocked || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('common.save')}
        </SaveButton>
      </Box>

      <Box className="routes-buckets">
        <Bucket
          tone={MOSS}
          label={t('routes.bucketDirect')}
          hint={t('routes.bucketDirectHint')}
          placeholder={'example.ru\ndomain:gosuslugi.ru'}
          value={draft.direct}
          onChange={(v) => patch({ direct: v })}
        />
        <Bucket
          tone={CYAN}
          label={t('routes.bucketProxy')}
          hint={t('routes.bucketProxyHint')}
          placeholder={'youtube.com\ndomain:google.com'}
          value={draft.proxy}
          onChange={(v) => patch({ proxy: v })}
        />
        <Bucket
          tone={RED}
          label={t('routes.bucketBlock')}
          hint={t('routes.bucketBlockHint')}
          placeholder="ads.example.com"
          value={draft.block}
          onChange={(v) => patch({ block: v })}
        />
      </Box>

      <Stack gap={6}>
        <FieldLabel>{t('routes.panelDnsTitle')}</FieldLabel>
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>{t('routes.panelDnsHint')}</Text>
        <Box style={{ marginInline: -20 }}>
          <DnsRulesEditor rows={draft.dns} onChange={(dns) => patch({ dns })} refused={dnsRefused} onTouch={() => setDnsRefused(NO_DNS_REFUSED)} />
          <DnsFormatsTable />
        </Box>
      </Stack>

      <Stack gap={6}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FieldLabel>{t('routes.rawRules')}</FieldLabel>
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 18,
              paddingInline: 7,
              borderRadius: 5,
              backgroundColor: WELL,
              border: `1px solid ${HAIRLINE}`,
            }}
          >
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 9,
                letterSpacing: '0.1em',
                lineHeight: '11px',
                textTransform: 'uppercase',
                color: FAINT,
              }}
            >
              {t('routes.advanced')}
            </Text>
          </Box>
        </Box>
        <Textarea
          autosize
          minRows={4}
          maxRows={16}
          placeholder={'[\n  { "type": "field", "domain": ["geosite:category-ru"], "outboundTag": "direct" }\n]'}
          value={draft.rules}
          onChange={(e) => patch({ rules: e.currentTarget.value })}
          styles={{ input: { fontFamily: MONO, fontSize: 12, lineHeight: '18px', color: SNOW } }}
        />
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
          {t('routes.rawRulesHint')}
        </Text>
      </Stack>
    </Stack>
  );
}

/* ───── Pieces ──────────────────────────────────────────────────────────── */
