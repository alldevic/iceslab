import { useTranslation } from 'react-i18next';
import { Stack, Text } from '@mantine/core';
import type { NodeDeleteFacts } from '@/contours/nodes/lib/nodeDelete';

/**
 * Строка окна удаления про каскады ноды, до кнопки (E28). Любой каскад,
 * включённый или выключенный: удаление откажет, кнопка недоступна (1bf18ca,
 * A-126). Решает `nodeDeleteFacts`, здесь только слова.
 */
export function NodeDeleteCascades({ facts }: { facts: NodeDeleteFacts }) {
  const { t } = useTranslation();
  if (!facts || facts.blocked.length === 0) return null;
  const names = (list: string[]) => list.map((n) => `«${n}»`).join(', ');
  return (
    <Stack gap={4}>
      <Text size="sm" c="red">
        {t('nodeConfirm.deleteBlocked', { count: facts.blocked.length, names: names(facts.blocked) })}
      </Text>
    </Stack>
  );
}

/** Подпись тоста отказа: что сделать и код сервера мелко. */
export function NodeInCascadeMessage() {
  const { t } = useTranslation();
  return (
    <Stack gap={4}>
      <Text size="sm">{t('nodeConfirm.inCascadeBody')}</Text>
      <Text size="xs" c="dimmed" ff="monospace">
        NODE_IN_USE_BY_CASCADE
      </Text>
    </Stack>
  );
}
