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
import { listUserWgDevices, revokeWgDevice, type WgDevice } from '@/lib/domain/users';
import { loadFailure } from '@/lib/ui/loadView';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { relativeTime } from '@/lib/ui/relativeTime';
import { wgDeviceForgetText } from '@/contours/users/lib/retentionWords';

/**
 * A user's WireGuard devices: a key per client, issued with the subscription.
 * What each moved and when, and revocation, which cuts off that client alone.
 * Revoked devices stay listed, greyed, with their traffic.
 */
export function WgDeviceList({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['user-wg-devices', userId],
    queryFn: () => listUserWgDevices(userId),
    staleTime: 30_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeWgDevice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-wg-devices', userId] });
      notifications.show({ color: 'green', message: t('userDrawer.wgDeviceRevokedNote') });
    },
    onError: (err) =>
      notifications.show({ color: 'red', title: t('common.deleteError'), message: apiErrorMessage(err) }),
  });
  const confirmRevoke = (d: WgDevice) =>
    modals.openConfirmModal({
      title: t('userDrawer.wgDeviceRevokeTitle', { n: d.index ?? '' }),
      children: <Text size="sm">{t('userDrawer.wgDeviceRevokeBody')}</Text>,
      labels: { confirm: t('userDrawer.wgDeviceRevoke'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => revoke.mutate(d.id),
    });

  const devices = query.data?.devices ?? [];
  const failure = loadFailure(query, apiErrorMessage);

  return (
    <Box style={{ borderRadius: 8, border: `1px solid ${HAIRLINE}`, backgroundColor: GROUND, padding: '10px 12px' }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: devices.length ? 8 : 0 }}>
        <IconKey size={13} stroke={1.8} color={MIST} />
        <Text style={{ ...LABEL, letterSpacing: '0.14em' }}>{t('userDrawer.wgDevices')}</Text>
      </Box>

      {query.isLoading && <Text style={{ fontSize: 11, color: MIST }}>{t('common.loading')}</Text>}
      {failure && <LoadFailedLine message={`${t('userDrawer.wgDevicesError')}: ${failure.message}`} onRetry={failure.onRetry} />}

      <Stack gap={5}>
        {devices.map((d) => {
          const live = d.revokedAt === null;
          return (
            <Box
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 9px',
                borderRadius: 6,
                backgroundColor: WELL,
                opacity: live ? 1 : 0.55,
              }}
            >
              <Text style={{ fontFamily: MONO, fontSize: 11, color: SNOW, flexShrink: 0 }} title={d.publicKey}>
                {d.label ?? (live ? `#${d.index}` : '—')}
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
                {!live
                  ? t('userDrawer.wgDeviceRevoked')
                  : d.lastSeenAt
                    ? relativeTime(d.lastSeenAt, t).text
                    : t('userDrawer.wgDeviceNever')}
              </Text>
              {live ? (
                <UnstyledButton
                  onClick={() => confirmRevoke(d)}
                  disabled={revoke.isPending}
                  title={t('userDrawer.wgDeviceRevoke')}
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
              ) : (
                <Box style={{ width: 22, flexShrink: 0 }} />
              )}
            </Box>
          );
        })}
      </Stack>

      {!query.isLoading && !query.isError && devices.length === 0 && (
        // Issued with the first download of the subscription, not before.
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: MIST }}>
          {t('userDrawer.wgDevicesEmpty')}
        </Text>
      )}
      <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: MIST, marginTop: 8 }}>
        {wgDeviceForgetText(t)}
      </Text>
    </Box>
  );
}
