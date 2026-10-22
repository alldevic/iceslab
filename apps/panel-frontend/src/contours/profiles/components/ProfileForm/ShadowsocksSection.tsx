import { useTranslation } from 'react-i18next';
import { Alert, Select, Stack, Text } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import type { FormValues } from '@/contours/profiles/lib/profileFormValues';
import { ssKeyState } from '@/contours/profiles/lib/ssServerKey';

export function ShadowsocksSection({
  form,
  isEdit,
  storedConfig,
}: {
  form: UseFormReturnType<FormValues>;
  isEdit: boolean;
  storedConfig: unknown;
}) {
  const { t } = useTranslation();
  const keyState = ssKeyState(storedConfig, isEdit, form.values.ssMethod);
  return (
            <Stack>
              <Select
                label={t('profiles.form.cfg.ssCipherLabel')}
                data={[
                  { value: '2022-blake3-aes-256-gcm', label: '2022-blake3-aes-256-gcm (recommended)' },
                  { value: '2022-blake3-aes-128-gcm', label: '2022-blake3-aes-128-gcm' },
                  { value: '2022-blake3-chacha20-poly1305', label: '2022-blake3-chacha20-poly1305' },
                  { value: 'chacha20-ietf-poly1305', label: 'chacha20-ietf-poly1305 (legacy AEAD)' },
                  { value: 'aes-256-gcm', label: 'aes-256-gcm (legacy AEAD)' },
                  { value: 'aes-128-gcm', label: 'aes-128-gcm (legacy AEAD)' },
                ]}
                allowDeselect={false}
                {...form.getInputProps('ssMethod')}
              />
              {/* The key itself is never shown: it is the server's secret, and
                  the form only has to say whether the save keeps it. */}
              <Text size="sm" c={keyState === 'set' || keyState === 'server' ? 'dimmed' : 'yellow'}>
                {t(`profiles.form.cfg.ssKey.${keyState}`)}
              </Text>
              <Alert color="blue" variant="light">
                <Text size="sm">
                  {t('profiles.form.cfg.ssNote')}
                </Text>
              </Alert>
            </Stack>
  );
}
