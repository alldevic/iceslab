import { Button, Code, CopyButton, Group, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import type { TFunction } from 'i18next';
import type { Node } from '@/lib/domain/nodes';
import { NodeDeleteCascades } from '@/contours/nodes/components/NodeDelete';
import { nodeDeleteFacts } from '@/contours/nodes/lib/nodeDelete';

/** The command that wipes the agent off the VPS once the node is deleted. */
const UNINSTALL_CMD =
  'bash <(curl -fsSL https://raw.githubusercontent.com/icecompany-tech/iceslab/main/scripts/install-iceslab-node.sh) --uninstall';

/**
 * The one window before a node delete, on the list and on the node page
 * (spec frontend-nodes): the cascades that hold the node lock the button
 * (A-126), and the cleanup command is shown on both, because the orphaned agent
 * keeps its mTLS port and an old cert pair wherever the delete was pressed.
 */
export function confirmNodeDelete(node: Node, t: TFunction, onConfirm: () => void): void {
  const cascades = nodeDeleteFacts(node);
  const blocked = (cascades?.blocked.length ?? 0) > 0;
  modals.openConfirmModal({
    title: t('nodeConfirm.deleteTitle', { name: node.name }),
    children: (
      <Stack gap="sm">
        <NodeDeleteCascades facts={cascades} />
        <Text size="sm">{t('nodeConfirm.deleteBody')}</Text>
        <Text size="sm" fw={600}>
          {t('nodeConfirm.deleteCleanupHint')}
        </Text>
        <Group gap="xs" align="flex-start" wrap="nowrap">
          <Code block style={{ flex: 1, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {UNINSTALL_CMD}
          </Code>
          <CopyButton value={UNINSTALL_CMD}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" color={copied ? 'teal' : 'blue'} onClick={copy}>
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Stack>
    ),
    labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
    confirmProps: { color: 'red', disabled: blocked, title: blocked ? t('nodeConfirm.deleteBlockedHint') : undefined },
    onConfirm,
  });
}

/**
 * The window before the node's mTLS certificate is renewed on request (A-124).
 * The panel confirms the new pair from a fresh connection; without that the
 * agent goes back to the old one by itself, so the window says it costs
 * nothing but a retry and does not touch users or links.
 */
export function confirmCertRotate(node: Pick<Node, 'name'>, t: TFunction, onConfirm: () => void): void {
  modals.openConfirmModal({
    title: t('nodeConfirm.certTitle', { name: node.name }),
    children: <Text size="sm">{t('nodeConfirm.certBody')}</Text>,
    labels: { confirm: t('nodeConfirm.certConfirm'), cancel: t('common.cancel') },
    confirmProps: { color: 'blue' },
    onConfirm,
  });
}

/**
 * The window before the node's connection log is wiped (owner's decision
 * 26.10). It says what goes: the WHOLE journal of the machine and its
 * syslog, not only the agent's lines, because the tools cannot pick lines.
 */
export function confirmConnLogClear(node: Pick<Node, 'name'>, t: TFunction, onConfirm: () => void): void {
  modals.openConfirmModal({
    title: t('nodeConfirm.connLogTitle', { name: node.name }),
    children: (
      <Stack gap="xs">
        <Text size="sm">{t('nodeConfirm.connLogBody')}</Text>
        <Text size="sm" fw={600}>
          {t('nodeConfirm.connLogWhole')}
        </Text>
      </Stack>
    ),
    labels: { confirm: t('nodeConfirm.connLogConfirm'), cancel: t('common.cancel') },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}

/**
 * The one window before a bootstrap token is re-issued, on the list and on the
 * node page (spec frontend-nodes). The page used to re-issue on one click.
 */
export function confirmBootstrapReissue(node: Pick<Node, 'name'>, t: TFunction, onConfirm: () => void): void {
  modals.openConfirmModal({
    title: t('nodeConfirm.reBootstrapTitle', { name: node.name }),
    children: <Text size="sm">{t('nodeConfirm.reBootstrapBody')}</Text>,
    labels: { confirm: t('nodeConfirm.reBootstrapConfirm'), cancel: t('common.cancel') },
    confirmProps: { color: 'blue' },
    onConfirm,
  });
}
