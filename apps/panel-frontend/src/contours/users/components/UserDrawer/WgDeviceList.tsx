import { apiErrorMessage } from '@/lib/net/client';
import { IconKey, IconX } from '@tabler/icons-react';
import { Box, Stack, Text, UnstyledButton } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DISPLAY, GROUND, HAIRLINE, MIST, MONO, SNOW, WELL } from '@/contours/users/lib/colors';
import { LABEL } from '@/contours/users/lib/userForm';
import { formatBytes } from '@/contours/users/lib/userFormat';
import { subscriptionLink } from '@/contours/users/lib/subscriptionLink';
import { fetchAuthStatus } from '@/lib/auth/api';
import { listUserWgDevices, revokeWgDevice, type WgDevice } from '@/lib/domain/users';
import { loadFailure } from '@/lib/ui/loadView';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { relativeTime } from '@/lib/ui/relativeTime';

/**
 * A user's WireGuard devices (milestone 9.6): a key per client, issued with the
 * subscription. What each moved, when it was last seen, its config, and
 * revocation, which cuts off that client alone and gets it a replacement.
 * A user with no WireGuard-family profile has no device and sees no card at all:
 * the drawer is what it was without the feature.
 */
export function WgDeviceList({ userId, subscriptionToken }: { userId: string; subscriptionToken: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['user-wg-devices', userId],
    queryFn: () => listUserWgDevices(userId),
    staleTime: 30_000,
  });
  // The same key the subscription card reads: the link is built from the
  // panel's public address, or not at all.
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: fetchAuthStatus, staleTime: 5 * 60 * 1000 });
  const link = subscriptionLink(subscriptionToken, status, apiErrorMessage);
  const revoke = useMutation({
    mutationFn: (id: string) => revokeWgDevice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-wg-devices', userId] });
      notifications.show({ color: 'green', message: t('userDrawer.wgDeviceRevokedNote') });
    },
    onError: (err) => notifications.show({ color: 'red', title: t('common.deleteError'), message: apiErrorMessage(err) }),
  });
  const confirmRevoke = (d: WgDevice) =>
    modals.openConfirmModal({
      title: t('userDrawer.wgDeviceRevokeTitle', { n: d.index }),
      children: <Text size="sm">{t('userDrawer.wgDeviceRevokeBody')}</Text>,
      labels: { confirm: t('userDrawer.wgDeviceRevoke'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => revoke.mutate(d.id),
    });

  const devices = query.data?.devices ?? [];
  const failure = loadFailure(query, apiErrorMessage);
  // Nothing to show: still loading, or no device (a user with no WireGuard).
  if (devices.length === 0 && !failure) return null;

  return (
    <Box style={{ borderRadius: 8, border: `1px solid ${HAIRLINE}`, backgroundColor: GROUND, padding: '10px 12px' }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: devices.length ? 8 : 0 }}>
        <IconKey size={13} stroke={1.8} color={MIST} />
        <Text style={{ ...LABEL, letterSpacing: '0.14em' }}>{t('userDrawer.wgDevices')}</Text>
      </Box>

      {failure && <LoadFailedLine message={`${t('userDrawer.wgDevicesError')}: ${failure.message}`} onRetry={failure.onRetry} />}

      <Stack gap={5}>
        {devices.map((d) => (
          <Box
            key={d.id}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', borderRadius: 6, backgroundColor: WELL }}
          >
            <Text style={{ fontFamily: MONO, fontSize: 11, color: SNOW, flexShrink: 0 }} title={d.publicKey}>
              {d.label ?? `#${d.index}`}
            </Text>
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: MONO,
                fontSize: 10,
                color: MIST,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={d.addresses.join(', ')}
            >
              {d.addresses.join(' / ') || '—'}
            </Text>
            <Text style={{ fontFamily: MONO, fontSize: 10, color: MIST, flexShrink: 0 }}>
              ↑ {formatBytes(Number(d.bytesOut))} ↓ {formatBytes(Number(d.bytesIn))}
            </Text>
            <Text style={{ fontFamily: DISPLAY, fontSize: 10, color: MIST, flexShrink: 0, minWidth: 64, textAlign: 'right' }}>
              {d.lastSeenAt ? relativeTime(d.lastSeenAt, t).text : t('userDrawer.wgDeviceNever')}
            </Text>
            {link.kind === 'ready' && (
              <a
                href={`${link.url}?format=wgconf&device=${d.index}&dl=1`}
                title={t('userDrawer.wgDeviceConfigHint')}
                style={{ fontFamily: DISPLAY, fontSize: 10, color: MIST, flexShrink: 0 }}
              >
                {t('userDrawer.wgDeviceConfig')}
              </a>
            )}
            <UnstyledButton
              onClick={() => confirmRevoke(d)}
              disabled={revoke.isPending}
              title={t('userDrawer.wgDeviceRevoke')}
              aria-label={t('userDrawer.wgDeviceRevoke')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: 5,
                border: `1px solid ${HAIRLINE}`,
                color: MIST,
                flexShrink: 0,
              }}
            >
              <IconX size={12} stroke={2.2} />
            </UnstyledButton>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
