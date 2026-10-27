import { Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { generateStep, type GenerateImpact } from '@/contours/profiles/lib/generateImpact';
import type { TFn } from '@/lib/ui/relativeTime';

/**
 * Ask before replacing a key pair, with the server's numbers (A-225).
 *
 * Deliberately not a plain "are you sure": the cost of this one is measured in
 * hosts, nodes and client configs, so the dialog repeats the measurement. When
 * the count did not arrive the dialog still opens and says the cost is not
 * known: a failed count used to read as zero and skip the question. While the
 * count is on its way nothing happens (the button also waits for it).
 */
export function confirmGenerate(impact: GenerateImpact, t: TFn, run: () => void): void {
  const step = generateStep(impact);
  if (step === 'wait') return;
  if (step === 'run') {
    run();
    return;
  }

  modals.openConfirmModal({
    title: t('profiles.generate.confirmTitle'),
    children: (
      <Stack gap={8}>
        <Text size="sm">
          {impact.kind === 'ready'
            ? t('profiles.generate.confirmBody', { hosts: impact.hosts, nodes: impact.nodes, configs: impact.configs })
            : t('profiles.generate.confirmUnknown')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('profiles.generate.body')}
        </Text>
      </Stack>
    ),
    labels: { confirm: t('profiles.generate.confirmAction'), cancel: t('common.cancel') },
    confirmProps: { color: 'red' },
    onConfirm: run,
  });
}
