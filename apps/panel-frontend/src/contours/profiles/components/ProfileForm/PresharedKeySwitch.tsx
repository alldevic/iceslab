import { useTranslation } from 'react-i18next';
import { Alert, Stack, Switch, Text } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import type { FormValues } from '@/contours/profiles/lib/profileFormValues';

/**
 * The profile's preshared-key flag (milestone 9.5), for AmneziaWG and plain
 * WireGuard alike. The warning is not optional: either way the flag flips, every
 * config already issued from the profile stops handshaking, and neither side
 * says why. It shows before the save, not after.
 */
export function PresharedKeySwitch({
  form,
  field,
}: {
  form: UseFormReturnType<FormValues>;
  field: 'awgPresharedKey' | 'wgPresharedKey';
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={6}>
      <Switch
        label={t('profiles.form.cfg.presharedKeyLabel')}
        description={t('profiles.form.cfg.presharedKeyHint')}
        {...form.getInputProps(field, { type: 'checkbox' })}
      />
      <Alert color="yellow" variant="light" p="xs">
        <Text size="xs">{t('profiles.form.cfg.presharedKeyWarning')}</Text>
      </Alert>
    </Stack>
  );
}
