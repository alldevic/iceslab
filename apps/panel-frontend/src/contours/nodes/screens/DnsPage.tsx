import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { listAllNodes, type Node } from '@/lib/domain/nodes';
import { loadFailure } from '@/lib/ui/loadView';
import { usePageMeta } from '@/lib/ui/usePageMeta';
import { apiErrorMessage } from '@/lib/net/client';
import { LoadFailed } from '@/ui/LoadFailed';
import { dnsReach } from '@/contours/nodes/lib/dnsReach';
import { dnsSummary } from '@/contours/nodes/lib/nodeDnsForm';
import { AMBER, CARD, CYAN, DISPLAY, FAINT, HAIRLINE, MIST, MONO, MOSS, RED, SNOW, WELL } from '@/contours/nodes/lib/colors';

/**
 * DNS по нодам: у какой ноды сколько серверов и доменов и какие её ядра это
 * исполняют. Правка живёт в форме ноды (блок «DNS»), сюда оператор только
 * приходит посмотреть и переходит по ссылке.
 */
export function DnsPage() {
  const { t } = useTranslation();
  usePageMeta([]);

  const nodesQuery = useQuery({ queryKey: ['nodes', 'all'], queryFn: () => listAllNodes() });
  const failure = loadFailure(nodesQuery, apiErrorMessage);
  const nodes = nodesQuery.data?.nodes ?? [];

  return (
    <Stack gap={20}>
      <Box
        style={{
          padding: '14px 18px',
          borderRadius: 12,
          backgroundColor: CARD,
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 15, fontWeight: 500, color: SNOW }}>{t('dnsPage.title')}</Text>
          <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
            {nodesQuery.data ? t('dnsPage.count', { n: nodes.length }) : ''}
          </Text>
        </Box>
        <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '17px', color: FAINT, marginTop: 2 }}>
          {t('dnsPage.intro')}
        </Text>
      </Box>

      {failure && <LoadFailed message={failure.message} onRetry={failure.onRetry} />}
      {nodesQuery.isLoading && <Placeholder title={t('common.loading')} body="" />}
      {nodesQuery.data && nodes.length === 0 && (
        <Placeholder title={t('dnsPage.emptyTitle')} body={t('dnsPage.emptyBody')} />
      )}

      {nodes.map((n) => (
        <NodeDnsRow key={n.id} node={n} />
      ))}
    </Stack>
  );
}

function NodeDnsRow({ node }: { node: Node }) {
  const { t } = useTranslation();
  const { servers, domains } = dnsSummary(node);
  const reach = dnsReach(node.cores?.cores);
  // Идёт речь о настройке, которой нет: тогда «исполняют ли ядра» ничего не
  // говорит, и строка про ядра не нужна. Предупреждение о ядрах появляется
  // только там, где настройка есть.
  const configured = servers > 0;

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        borderRadius: 10,
        backgroundColor: WELL,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 13, color: SNOW }}>{node.name}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 10, lineHeight: '14px', color: FAINT }}>
          {configured ? t('dnsPage.summary', { servers, domains }) : t('dnsPage.builtIn')}
        </Text>
      </Stack>

      <Stack gap={2} style={{ width: 300, flexShrink: 0 }}>
        <Text
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: reach.state === 'executes' ? MOSS : reach.state === 'not-executes' ? RED : AMBER,
          }}
        >
          {reach.state === 'executes'
            ? t('dnsPage.state.executes')
            : reach.state === 'not-executes'
              ? t('dnsPage.state.not-executes')
              : t('dnsPage.state.unknown')}
        </Text>
        <Text style={{ fontFamily: MONO, fontSize: 10, lineHeight: '14px', color: FAINT }}>
          {[
            reach.executing.length > 0 && t('dnsPage.executing', { cores: reach.executing.join(', ') }),
            reach.notExecuting.length > 0 && t('dnsPage.notExecuting', { cores: reach.notExecuting.join(', ') }),
            reach.unknown.length > 0 && t('dnsPage.unanswered', { cores: reach.unknown.join(', ') }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Stack>

      <Link
        to={`/nodes/${node.id}#dns`}
        style={{ fontFamily: MONO, fontSize: 11, color: CYAN, textDecoration: 'underline', textUnderlineOffset: 2, flexShrink: 0 }}
      >
        {t('dnsPage.edit')}
      </Link>
    </Box>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <Box style={{ padding: '28px 22px', borderRadius: 12, backgroundColor: CARD, border: `1px dashed ${HAIRLINE}` }}>
      <Stack gap={8}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 14, color: SNOW }}>{title}</Text>
        {body && <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '18px', color: MIST, maxWidth: 680 }}>{body}</Text>}
      </Stack>
    </Box>
  );
}
