import { apiErrorMessage } from '@/lib/net/client';
import { IconDeviceDesktop, IconX } from '@tabler/icons-react';
import { Box, Stack, Text, UnstyledButton } from '@mantine/core';
import { DISPLAY, GROUND, HAIRLINE, MIST, MONO, RED, SNOW, WELL } from '@/contours/users/lib/colors';
import { LABEL } from '@/contours/users/lib/userForm';
import { deleteHwidDevice, listUserDevices } from '@/lib/domain/users';
import { deviceListView, type DeviceCap } from '@/contours/users/lib/deviceLimit';
import { deviceForgetText } from '@/contours/users/lib/retentionWords';
import { loadFailure } from '@/lib/ui/loadView';
import { LoadFailedLine } from '@/ui/LoadFailed';
import { notifications } from '@mantine/notifications';
import { relativeTime } from '@/lib/ui/relativeTime';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
/** Devices against the limit the user is actually held to (A-148,
 *  `effectiveDeviceCap`): their own, the squads', or none. */
export function DeviceList({ userId, cap }: { userId: string; cap: DeviceCap }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const devicesQuery = useQuery({
    queryKey: ['user-devices', userId],
    queryFn: () => listUserDevices(userId),
    staleTime: 30_000,
  });
  const resetMutation = useMutation({
    mutationFn: (id: string) => deleteHwidDevice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-devices', userId] });
      notifications.show({ color: 'green', message: t('userDrawer.deviceReset') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.deleteError'),
        message: apiErrorMessage(err),
      }),
  });

  const devices = devicesQuery.data?.devices ?? [];
  // A-254: a list that did not arrive counts «-», not 0, and says why with a retry.
  const view = deviceListView(devicesQuery, (q) => loadFailure(q, apiErrorMessage));
  const used = view.used ?? '-';
  const full = cap.kind === 'limit' && view.used !== null && view.used >= cap.limit;
  const counter =
    cap.kind === 'limit'
      ? t(cap.from === 'squad' ? 'userDrawer.devicesCounterSquad' : 'userDrawer.devicesCounter', { used, limit: cap.limit })
      : cap.kind === 'none'
        ? t(cap.from === 'user' ? 'userDrawer.devicesCounterUnlimited' : 'userDrawer.devicesCounterNoLimit', { used })
        : t('userDrawer.devicesCounterUnknown', { used });

  return (
    <Box
      style={{
        borderRadius: 8,
        border: `1px solid ${HAIRLINE}`,
        backgroundColor: GROUND,
        padding: '10px 12px',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: devices.length ? 8 : 0 }}>
        <IconDeviceDesktop size={13} stroke={1.8} color={full ? RED : MIST} />
        <Text style={{ ...LABEL, letterSpacing: '0.14em' }}>{t('userDrawer.devices')}</Text>
        <Box style={{ flex: 1 }} />
        <Text style={{ fontFamily: MONO, fontSize: 10, color: full ? RED : MIST }}>
          {counter}
        </Text>
      </Box>

      {devicesQuery.isLoading && (
        <Text style={{ fontSize: 11, color: MIST }}>{t('common.loading')}</Text>
      )}
      {view.failure && (
        <LoadFailedLine
          message={`${t('userDrawer.devicesError')}: ${view.failure.message}`}
          onRetry={view.failure.onRetry}
        />
      )}

      <Stack gap={5}>
        {devices.map((d) => (
          <Box
            key={d.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 9px',
              borderRadius: 6,
              backgroundColor: WELL,
            }}
          >
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
              // The full hwid is what the client actually sent, and it is the
              // only way to tell two unlabelled devices apart.
              title={d.hwid}
            >
              {d.label ?? `${d.hwid.slice(0, 12)}…`}
            </Text>
            <Text style={{ fontFamily: MONO, fontSize: 10, color: MIST, flexShrink: 0 }}>
              {relativeTime(d.lastSeenAt, t).text}
            </Text>
            <UnstyledButton
              onClick={() => resetMutation.mutate(d.id)}
              disabled={resetMutation.isPending}
              title={t('userDrawer.deviceResetHint')}
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

      {!devicesQuery.isLoading && !devicesQuery.isError && devices.length === 0 && (
        // Empty is the normal starting state, not a fault: a device row appears
        // the first time a client sends its identifier, and never before.
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: MIST }}>
          {t('userDrawer.devicesEmpty')}
        </Text>
      )}
      {/* A-269: a device the client stopped sending frees its slot by itself. */}
      <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: MIST, marginTop: 8 }}>
        {deviceForgetText(t)}
      </Text>
      {full && devices.length > 0 && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: RED, marginTop: 8 }}>
          {t('userDrawer.devicesFull')}
        </Text>
      )}
    </Box>
  );
}
