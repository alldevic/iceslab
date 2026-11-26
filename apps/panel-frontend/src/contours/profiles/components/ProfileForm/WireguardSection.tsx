import { useTranslation } from 'react-i18next';
import { Alert, Button, Group, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import type { UseFormReturnType } from '@mantine/form';
import { PresharedKeySwitch } from '@/contours/profiles/components/ProfileForm/PresharedKeySwitch';
import { GenerateWarning } from '@/contours/profiles/components/ProfileForm/GenerateWarning';
import { confirmGenerate } from '@/contours/profiles/lib/confirmGenerate';
import { showGenerateWarning, useGenerateGate } from '@/contours/profiles/lib/generateImpact';
import type { FormValues } from '@/contours/profiles/lib/profileFormValues';

/**
 * Plain WireGuard (milestone 9.3): a subnet and the server keypair, nothing
 * else. No obfuscation block, no preset, no generation. The port is the
 * binding's, set on deploy.
 */
export function WireguardSection({
  generateWgKeys,
  keypairPending,
  form,
  isEdit,
  profileId,
}: {
  generateWgKeys: () => Promise<void>;
  keypairPending: boolean;
  form: UseFormReturnType<FormValues>;
  isEdit: boolean;
  profileId: string | null;
}) {
  const { t } = useTranslation();
  // The warning reads the cached count; the press asks the server again (A-225).
  const { impact, checking, press } = useGenerateGate(profileId);
  return (
    <Stack>
      {/* What this protocol is and is not, before anyone picks it for the
          wrong reason: it is not hidden from DPI, and it leaves the node
          directly (no cascade, no zapret2, no WARP). */}
      <Alert color="yellow" variant="light" p="xs">
        <Text size="xs" component="div">
          <strong>{t('profileForm.wgImportantTitle')}</strong>
          <ul style={{ margin: '4px 0 0 16px', paddingLeft: 0 }}>
            <li>{t('profileForm.wgImportant1')}</li>
            <li>{t('profileForm.wgImportant2')}</li>
            <li>{t('profileForm.wgImportant3')}</li>
          </ul>
        </Text>
      </Alert>
      <Group align="flex-start" wrap="nowrap" gap="md">
        <TextInput
          w={220}
          label={t('profiles.form.cfg.awgSubnetLabel')}
          placeholder="10.77.77.0/24"
          description={isEdit ? t('profiles.form.cfg.awgSubnetLockedHint') : t('profiles.form.cfg.wgSubnetHint')}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          required
          {...form.getInputProps('wgSubnet')}
        />
        <Group flex={1} align="end" wrap="nowrap" gap="xs">
          <PasswordInput
            flex={1}
            label={t('profiles.form.cfg.awgServerPrivLabel')}
            required
            {...form.getInputProps('wgServerPriv')}
          />
          <Button
            leftSection={<IconKey size={14} />}
            variant="light"
            loading={keypairPending}
            // The cost has to be known (or known to be unknown) first: A-225.
            disabled={impact.kind === 'loading' || checking}
            onClick={() => press((fresh) => confirmGenerate(fresh, t, () => void generateWgKeys()))}
            type="button"
          >
            {t('profiles.form.cfg.generate')}
          </Button>
        </Group>
        <TextInput
          flex={1}
          label={t('profiles.form.cfg.awgServerPubLabel')}
          placeholder={t('profiles.form.cfg.awgServerPubPlaceholder')}
          required
          {...form.getInputProps('wgServerPub')}
        />
      </Group>
      {isEdit && showGenerateWarning(impact) && <GenerateWarning impact={impact} />}
      <PresharedKeySwitch form={form} field="wgPresharedKey" />
    </Stack>
  );
}
