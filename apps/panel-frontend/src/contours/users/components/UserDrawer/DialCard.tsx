import { IconList } from '@tabler/icons-react';
import { Box, Text, UnstyledButton } from '@mantine/core';
import { CARD, CYAN, FAINT, DISPLAY, HAIRLINE, MIST, MONO, MOSS, SNOW, WELL } from '@/contours/users/lib/colors';
import { LABEL } from '@/contours/users/lib/userForm';
import { dialCopy } from '@/contours/users/lib/dialCopy';
import { CopyButton } from '@/ui/CopyButton';
import { dialTabOf, dialTabs } from '@/contours/users/lib/dialTabs';
import { endpointsWhy } from '@/contours/users/lib/endpointsWhy';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserForm } from '@/contours/users/components/UserDrawer/useUserForm';

type EndpointsQuery = UserForm['endpointsQuery'];

/**
 * The lines this person can actually dial, one protocol at a time.
 *
 * The preview above answers "how much did I just hand out"; this answers "give
 * me the one line for the client that is on the phone right now". They are
 * different questions, which is why the subscription link and a single URI
 * both have a place here.
 */
export function DialCard({ query }: { query: EndpointsQuery }) {
  const { t } = useTranslation();

  const endpoints = useMemo(() => query.data?.endpoints ?? [], [query.data]);
  // A tab per protocol, and SOCKS5 / HTTP apart from the rest of xray: see
  // dialTabs for why.
  const tabs = useMemo(() => dialTabs(endpoints), [endpoints]);
  const [active, setActive] = useState<string | null>(null);
  const current = active && tabs.some((tab) => tab.key === active) ? active : (tabs[0]?.key ?? null);
  const shown = endpoints.filter((e) => dialTabOf(e).key === current);

  /**
   * Why there is nothing to dial, when there is nothing.
   *
   * The card used to vanish on an empty list, which left an operator unable to
   * tell "this account is served nothing" from "the panel forgot to draw the
   * block". A 403 is its own answer: the subscription endpoint refuses an
   * account that has expired, run out or had its link revoked.
   */
  const why = endpointsWhy(query);
  const empty =
    why === 'loading'
      ? t('common.loading')
      : why === 'refused'
        ? t('userDrawer.dialRefused')
        : why === 'failed'
          ? t('userDrawer.dialError')
          : why === 'empty'
            ? t('userDrawer.dialEmpty')
            : null;

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 10,
        backgroundColor: CARD,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconList size={13} stroke={1.7} color={CYAN} />
        <Text style={{ ...LABEL, letterSpacing: '0.14em' }}>{t('userDrawer.dialTitle')}</Text>
        <Box style={{ flex: 1 }} />
        {/* No list, no count (A-141). */}
        {why !== 'failed' && why !== 'loading' && (
          <Text style={{ fontFamily: MONO, fontSize: 10, lineHeight: '12px', color: FAINT }}>
            {endpoints.length} {t('userDrawer.configs', { count: endpoints.length })}
          </Text>
        )}
      </Box>

      {empty && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
          {empty}
        </Text>
      )}

      <Box style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tabs.map((tab) => {
          const on = tab.key === current;
          return (
            <UnstyledButton
              key={tab.key}
              onClick={() => setActive(tab.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 24,
                paddingInline: 12,
                borderRadius: 6,
                backgroundColor: on ? `${CYAN}24` : WELL,
                border: `1px solid ${on ? `${CYAN}55` : HAIRLINE}`,
              }}
            >
              <Text
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: on ? CYAN : MIST,
                }}
              >
                {tab.label}
              </Text>
            </UnstyledButton>
          );
        })}
      </Box>

      {shown.map((e, i) => (
        <Box
          key={`${e.nodeId}-${e.port}-${i}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 10px',
            borderRadius: 6,
            backgroundColor: WELL,
          }}
        >
          <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: MOSS, flexShrink: 0 }} />
          <Text
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: DISPLAY,
              fontSize: 12,
              color: SNOW,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {e.label}
          </Text>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: MIST, flexShrink: 0 }}>
            {e.port}
          </Text>
          {(() => {
            // Что делает кнопка, решает фабрика: у AmneziaWG строки-ссылки нет,
            // и копировать пустоту кнопка не должна.
            const c = dialCopy(e.uri, e.protocol);
            return (
              <CopyButton text={e.uri} label={t(c.labelKey)} title={t(c.titleKey)} disabled={!c.enabled} />
            );
          })()}
        </Box>
      ))}

      {endpoints.length > 0 && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
          {t('userDrawer.dialHint', {
            configs: endpoints.length,
            nodes: new Set(endpoints.map((e) => e.nodeId)).size,
          })}
        </Text>
      )}
    </Box>
  );
}
