import { useState } from 'react';
import { Box, Button, Group, Modal, Select, Stack, TagsInput, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { EgressRule, EgressTarget } from '../lib/api';
import { AMBER, CARD, EDGE, FAINT, HAIRLINE, MIST, MONO, WELL } from './CascadeEditor';

/**
 * Authors the geo split for ONE node.
 *
 * Per node, not per cascade or per position, because a position is a POOL: the
 * split belongs to the box that actually egresses, and one policy spread over a
 * whole pool is the class of mistake the pool model exists to prevent.
 *
 * Targets read in the client's terms rather than the config's:
 *   direct     - leave from this node
 *   block      - drop it
 *   link-out   - keep going the way the subscriber already chose
 *   direction  - force one way out, whatever they chose
 * The last one names a direction by TAG, because a tag outlives the nodes
 * currently standing behind it.
 */

export interface DirectionChoice {
  tag: number;
  label: string;
}

const EMPTY_RULE: EgressRule = { geosite: [], target: 'direct' };

/** Does the rule name anything at all to match on? Without it xray would treat
 *  the rule as a catch-all and it would shadow every rule below. */
function hasMatcher(r: EgressRule): boolean {
  return Boolean(r.geosite?.length || r.geoip?.length || r.domain?.length || r.ip?.length);
}

/** A rule the form cannot draw without losing part of it (port/network matchers
 *  are API-only for now). Shown read-only rather than silently rewritten. */
function isAdvanced(r: EgressRule): boolean {
  return r.port !== undefined || r.network !== undefined;
}

function summarise(r: EgressRule): string {
  const parts = [
    ...(r.geosite ?? []),
    ...(r.geoip ?? []).map((c) => `geoip:${c}`),
    ...(r.domain ?? []),
    ...(r.ip ?? []),
  ];
  const head = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` +${parts.length - 3}` : '');
  return `${head || '—'} → ${r.target}`;
}

export function EgressPolicyEditor({
  opened,
  nodeLabel,
  policy,
  directions,
  onClose,
  onSave,
}: {
  opened: boolean;
  nodeLabel: string;
  policy: EgressRule[];
  /** Ways out this cascade currently has, for the `direction` target. */
  directions: DirectionChoice[];
  onClose: () => void;
  onSave: (next: EgressRule[]) => void;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<EgressRule[]>(policy);

  // Re-seed whenever the dialog is reopened: the draft is per opening, and a
  // stale one would silently overwrite a policy edited elsewhere.
  const [seed, setSeed] = useState(opened);
  if (opened !== seed) {
    setSeed(opened);
    if (opened) setRules(policy);
  }

  const patch = (i: number, next: Partial<EgressRule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...next } : r)));

  // Forcing a direction needs a direction that already has its TAG, and tags are
  // issued server-side on first save. While creating a cascade there are none,
  // so the option is left out rather than offered with an empty picker.
  const targetOptions: { value: EgressTarget; label: string }[] = [
    { value: 'direct', label: t('cascades.targetDirect') },
    { value: 'link-out', label: t('cascades.targetLinkOut') },
    ...(directions.length > 0
      ? [{ value: 'direction' as EgressTarget, label: t('cascades.targetDirection') }]
      : []),
    { value: 'block', label: t('cascades.targetBlock') },
  ];

  return (
    <Modal opened={opened} onClose={onClose} title={`${t('cascades.split')} — ${nodeLabel}`} size="lg" centered>
      <Stack gap={12}>
        <Text size="xs" style={{ color: MIST, lineHeight: 1.5 }}>
          {t('cascades.splitHint')}
        </Text>

        {rules.map((r, i) =>
          isAdvanced(r) ? (
            <Box
              key={i}
              style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}
            >
              <Text size="xs" style={{ color: FAINT, fontFamily: MONO }}>
                {t('cascades.splitRawRule', { summary: summarise(r) })}
              </Text>
            </Box>
          ) : (
            <Box
              key={i}
              style={{ padding: 12, borderRadius: 8, backgroundColor: CARD, border: `1px solid ${EDGE}` }}
            >
              <Stack gap={8}>
                <TagsInput
                  size="xs"
                  label={t('cascades.splitGeosite')}
                  description={t('cascades.splitGeositeHint')}
                  value={r.geosite ?? []}
                  onChange={(v) => patch(i, { geosite: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascades.splitGeoip')}
                  value={r.geoip ?? []}
                  onChange={(v) => patch(i, { geoip: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascades.splitDomain')}
                  value={r.domain ?? []}
                  onChange={(v) => patch(i, { domain: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascades.splitIp')}
                  description={t('cascades.splitIpHint')}
                  value={r.ip ?? []}
                  onChange={(v) => patch(i, { ip: v })}
                />
                <Group gap={8} align="flex-end" wrap="nowrap">
                  <Select
                    size="xs"
                    label={t('cascades.splitTarget')}
                    data={targetOptions}
                    value={r.target}
                    allowDeselect={false}
                    onChange={(v) =>
                      patch(i, {
                        target: (v ?? 'direct') as EgressTarget,
                        // Dropping the tag with the target keeps a stale one from
                        // riding along on a rule that no longer names a direction.
                        ...(v === 'direction' ? {} : { directionTag: undefined }),
                      })
                    }
                    style={{ flex: 1 }}
                  />
                  {r.target === 'direction' && (
                    <Select
                      size="xs"
                      label={t('cascades.splitDirectionTag')}
                      data={directions.map((d) => ({ value: String(d.tag), label: d.label }))}
                      value={r.directionTag != null ? String(r.directionTag) : null}
                      onChange={(v) => patch(i, { directionTag: v ? Number(v) : undefined })}
                      style={{ flex: 1 }}
                    />
                  )}
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    {t('cascades.removeRule')}
                  </Button>
                </Group>
                {!hasMatcher(r) && (
                  // Saving drops it (a rule with nothing to match on would act as
                  // a catch-all and shadow everything under it), so say that here
                  // rather than let the row quietly disappear on save.
                  <Text size="xs" style={{ color: AMBER }}>
                    {t('cascades.splitRuleEmpty')}
                  </Text>
                )}
              </Stack>
            </Box>
          ),
        )}

        <Button size="xs" variant="default" onClick={() => setRules([...rules, { ...EMPTY_RULE }])}>
          {t('cascades.splitAddRule')}
        </Button>

        <Group justify="flex-end" gap={8}>
          <Button size="xs" variant="subtle" style={{ color: MIST }} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="xs"
            onClick={() => {
              // Drop rules with nothing to match on: an empty rule would behave
              // as a catch-all on the node and shadow the routing below it.
              const cleaned = rules.filter((r) => isAdvanced(r) || hasMatcher(r));
              onSave(cleaned);
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Compact "has a split / n rules" affordance shown next to a node picker. */
export function SplitBadge({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="compact-xs"
      variant={count > 0 ? 'light' : 'subtle'}
      color={count > 0 ? 'cyan' : 'gray'}
      onClick={onClick}
      title={t('cascades.split')}
      // Muted until there is something to show: a node without a split is the
      // ordinary case, and an accent on every row would read as a warning.
      style={{ flexShrink: 0, ...(count > 0 ? {} : { color: FAINT }) }}
    >
      {count > 0 ? `geo ${count}` : 'geo'}
    </Button>
  );
}
