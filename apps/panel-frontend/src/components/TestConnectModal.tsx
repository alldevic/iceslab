import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import {
  IconBolt,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconShieldLock,
} from '@tabler/icons-react';
import { testConnectProfile, type TestConnectResult, type Profile } from '../lib/api';

interface Props {
  profile: Profile | null;
  onClose: () => void;
}

/**
 * Slice 31 - admin clicks "Test connect" in a profile card and the panel
 * fires outbound probes against every binding × host. Results appear as a
 * list of green / red rows with TLS handshake CN, latency, or the probe
 * error string. UDP-based protocols (Hysteria/AmneziaWG/Mieru) get a
 * yellow caveat - the TCP-port probe doesn't actually validate them.
 *
 * Differentiator vs Remnawave / Marzban: those panels make the admin SSH
 * to the node and run a curl/openssl manually to verify a fresh inbound.
 * Here it's one click and the panel does the network IO from its
 * container - same network path the subscription generator runs from.
 */
export function TestConnectModal({ profile, onClose }: Props) {
  const { t } = useTranslation();
  const [results, setResults] = useState<TestConnectResult[] | null>(null);

  const mutation = useMutation({
    mutationFn: (id: string) => testConnectProfile(id),
    onSuccess: (data) => setResults(data.results),
  });

  // Auto-fire on open so the admin doesn't have to click twice.
  useEffect(() => {
    if (profile) {
      setResults(null);
      mutation.mutate(profile.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  return (
    <Modal
      opened={profile !== null}
      onClose={onClose}
      title={
        <Group gap="sm">
          <ThemeIcon size={28} radius="md" variant="light" color="cyan">
            <IconBolt size={16} />
          </ThemeIcon>
          <Stack gap={0}>
            <Text fw={600}>{t('testConnect.title')}</Text>
            <Text size="xs" c="dimmed">
              {profile?.name}
            </Text>
          </Stack>
        </Group>
      }
      size="lg"
    >
      <Stack gap="sm">
        <Alert color="blue" variant="light" icon={<IconShieldLock size={14} />}>
          {t('testConnect.caveat')}
        </Alert>

        {mutation.isPending && (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            {t('testConnect.probing')}
          </Text>
        )}

        {mutation.isError && (
          <Alert color="red" variant="light">
            {mutation.error instanceof Error
              ? mutation.error.message
              : t('testConnect.failed')}
          </Alert>
        )}

        {results && results.length === 0 && (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            {t('testConnect.noBindings')}
          </Text>
        )}

        {results && results.length > 0 && (
          <Stack gap={4}>
            {results.map((r, i) => (
              <ResultRow key={`${r.bindingId}-${r.hostId ?? i}`} result={r} />
            ))}
          </Stack>
        )}

        <Group justify="space-between">
          <Button
            variant="light"
            loading={mutation.isPending}
            disabled={!profile}
            onClick={() => {
              if (profile) {
                setResults(null);
                mutation.mutate(profile.id);
              }
            }}
          >
            {t('testConnect.rerun')}
          </Button>
          <Button variant="subtle" onClick={onClose}>
            {t('common.close')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ResultRow({ result }: { result: TestConnectResult }) {
  const { t } = useTranslation();
  const okColor = result.ok ? 'teal' : 'red';
  const Icon = result.ok ? IconCircleCheck : IconCircleX;
  return (
    <Paper
      withBorder
      p="xs"
      radius="sm"
      style={{
        borderLeft: `3px solid var(--mantine-color-${okColor}-6)`,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <ThemeIcon size={20} radius="xl" variant="light" color={okColor}>
              <Icon size={14} />
            </ThemeIcon>
            <Text size="sm" fw={500} truncate>
              {result.nodeName}
            </Text>
            <Badge size="xs" variant="light" color="grape">
              {result.hostRemark}
            </Badge>
            <Badge size="xs" variant="light" color="gray" tt="uppercase">
              {result.probe}
            </Badge>
          </Group>
          <Group gap={6} wrap="wrap">
            <Code style={{ fontSize: 11 }}>
              {result.endpoint}:{result.port}
            </Code>
            {result.sni && (
              <Tooltip label={t('testConnect.sniTooltip')}>
                <Code style={{ fontSize: 11 }}>SNI={result.sni}</Code>
              </Tooltip>
            )}
            {result.certCn && (
              <Tooltip label={t('testConnect.certTooltip')}>
                <Code style={{ fontSize: 11 }}>cert={result.certCn}</Code>
              </Tooltip>
            )}
            {result.tlsVersion && (
              <Tooltip label={t('testConnect.tlsTooltip')}>
                <Code
                  style={{ fontSize: 11 }}
                  c={result.tlsVersion !== 'TLSv1.3' && result.kind === 'dest' ? 'red' : undefined}
                >
                  {result.tlsVersion}
                </Code>
              </Tooltip>
            )}
          </Group>
          {result.error && (
            <Text size="xs" c="red">
              {result.error}
            </Text>
          )}
          {result.notes && (
            <Text size="xs" c="yellow">
              ⚠ {result.notes}
            </Text>
          )}
        </Stack>
        {typeof result.latencyMs === 'number' && (
          <Group gap={4} wrap="nowrap">
            <IconClock size={12} />
            <Text size="xs" ff="monospace">
              {result.latencyMs}ms
            </Text>
          </Group>
        )}
      </Group>
    </Paper>
  );
}
