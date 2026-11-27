import { Alert, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { subnet6ChangeRestarts } from '@/contours/profiles/lib/subnet6';

/**
 * Before saving: a changed IPv6 subnet restarts the tunnel interface on the
 * nodes that carry IPv6 (18.10), and that drops the profile's peers for the
 * moment it takes to come back. No deferred apply: the line says so, the
 * operator decides.
 */
export function Subnet6Warning({ isEdit, saved, value }: { isEdit: boolean; saved: string; value: string }) {
  const { t } = useTranslation();
  if (!subnet6ChangeRestarts(isEdit, saved, value)) return null;
  return (
    <Alert color="yellow" variant="light" p="xs" style={{ maxWidth: 520 }} data-testid="subnet6-restart-warning">
      <Text size="xs">{t('profiles.form.cfg.subnet6Restart')}</Text>
    </Alert>
  );
}
