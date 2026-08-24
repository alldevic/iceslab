import { useState } from 'react';
import { Box, Button, Code, Group, Loader, Modal, Select, Stack, TagsInput, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage, previewGeoPolicy, type EgressRule, type EgressTarget } from '../lib/api';
import { AMBER, CARD, EDGE, FAINT, HAIRLINE, MIST, MONO, RED, WELL } from './CascadeEditor';

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
 *
 * ORDER IS SEMANTICS. xray stops at the FIRST rule whose condition matches, so
 * two rules over overlapping categories mean different things depending on which
 * one is above. The list is therefore explicitly ordered and reorderable here -
 * before this, changing your mind about precedence meant deleting a rule and
 * retyping it lower down, which is the kind of thing an operator does wrong once
 * and then does not trust again.
 */

export interface DirectionChoice {
  tag: number;
  label: string;
}

/**
 * What the PREVIEW needs and the policy cannot say: where the node sits, who is
 * on the step behind it, and how many outbounds serve each direction from here
 * (more than one means the node balances rather than dials).
 *
 * Threaded down from the page because only the page holds the draft topology,
 * and the draft is the point - the preview has to answer for the cascade being
 * edited, not for the one last saved.
 */
export interface SplitPreviewContext {
  /** The node being previewed. Lets the preview also show what that node's own
   *  egress policy contributes ahead of this split. */
  nodeId?: string;
  position: number;
  prevNodeIds: string[];
  /** direction tag -> outbounds serving it from this node. */
  outbounds: Record<number, number>;
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

/**
 * Can this rule be compiled as it stands? The preview asks the API to run the
 * REAL compiler, and the API refuses a policy the save would also refuse - so an
 * unfinished rule is held back and counted rather than turned into a red error
 * message that appears mid-keystroke.
 */
function previewable(r: EgressRule): boolean {
  if (r.target === 'direction' && r.directionTag == null) return false;
  return isAdvanced(r) || hasMatcher(r);
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

/**
 * The row above every rule: its position in the match order, and the two arrows
 * that change it.
 *
 * The number is not decoration - xray evaluates rules top to bottom and stops at
 * the first match, so "#1" is a statement about precedence. Both the plain and
 * the advanced (API-authored) rule boxes carry this, because an advanced rule
 * that cannot be edited here can still be in the wrong place.
 */
function RuleHead({
  index,
  total,
  onMove,
}: {
  index: number;
  total: number;
  onMove: (i: number, delta: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Text size="xs" style={{ color: FAINT, fontFamily: MONO }}>
        {`#${index + 1}`}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }} />
      <Button
        size="compact-xs"
        variant="subtle"
        style={{ color: MIST }}
        disabled={index === 0}
        title={t('cascadeEdit.splitMoveUp')}
        aria-label={t('cascadeEdit.splitMoveUp')}
        onClick={() => onMove(index, -1)}
      >
        ↑
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        style={{ color: MIST }}
        disabled={index === total - 1}
        title={t('cascadeEdit.splitMoveDown')}
        aria-label={t('cascadeEdit.splitMoveDown')}
        onClick={() => onMove(index, 1)}
      >
        ↓
      </Button>
    </Group>
  );
}

export function EgressPolicyEditor({
  opened,
  nodeLabel,
  policy,
  directions,
  preview,
  onClose,
  onSave,
}: {
  opened: boolean;
  nodeLabel: string;
  policy: EgressRule[];
  /** Ways out this cascade currently has, for the `direction` target. */
  directions: DirectionChoice[];
  /** Omit to hide the compiled-rules preview (nothing to compile against). */
  preview?: SplitPreviewContext;
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

  /** Swap a rule with its neighbour. Order is the policy's meaning (xray takes
   *  the first match), so this is an edit like any other, not a view preference. */
  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRules(next);
  };

  // Forcing a direction needs a direction that already has its TAG, and tags are
  // issued server-side on first save. While creating a cascade there are none,
  // so the option is left out rather than offered with an empty picker.
  const targetOptions: { value: EgressTarget; label: string }[] = [
    { value: 'direct', label: t('cascadeEdit.targetDirect') },
    { value: 'link-out', label: t('cascadeEdit.targetLinkOut') },
    ...(directions.length > 0
      ? [{ value: 'direction' as EgressTarget, label: t('cascadeEdit.targetDirection') }]
      : []),
    { value: 'block', label: t('cascadeEdit.targetBlock') },
  ];

  return (
    <Modal opened={opened} onClose={onClose} title={`${t('cascadeEdit.split')} — ${nodeLabel}`} size="lg" centered>
      <Stack gap={12}>
        <Text size="xs" style={{ color: MIST, lineHeight: 1.5 }}>
          {t('cascadeEdit.splitHint')}
        </Text>

        {rules.length > 1 && (
          // Said once, above the list, because it explains what the numbers and
          // the arrows are FOR. Without it the order reads as cosmetic.
          <Text size="xs" style={{ color: AMBER, lineHeight: 1.5 }}>
            {t('cascadeEdit.splitOrderHint')}
          </Text>
        )}

        {rules.map((r, i) =>
          isAdvanced(r) ? (
            <Box
              key={i}
              style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}
            >
              <Stack gap={8}>
                <RuleHead index={i} total={rules.length} onMove={move} />
                <Text size="xs" style={{ color: FAINT, fontFamily: MONO }}>
                  {t('cascadeEdit.splitRawRule', { summary: summarise(r) })}
                </Text>
              </Stack>
            </Box>
          ) : (
            <Box
              key={i}
              style={{ padding: 12, borderRadius: 8, backgroundColor: CARD, border: `1px solid ${EDGE}` }}
            >
              <Stack gap={8}>
                <RuleHead index={i} total={rules.length} onMove={move} />
                <TagsInput
                  size="xs"
                  label={t('cascadeEdit.splitGeosite')}
                  description={t('cascadeEdit.splitGeositeHint')}
                  value={r.geosite ?? []}
                  onChange={(v) => patch(i, { geosite: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascadeEdit.splitGeoip')}
                  value={r.geoip ?? []}
                  onChange={(v) => patch(i, { geoip: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascadeEdit.splitDomain')}
                  value={r.domain ?? []}
                  onChange={(v) => patch(i, { domain: v })}
                />
                <TagsInput
                  size="xs"
                  label={t('cascadeEdit.splitIp')}
                  description={t('cascadeEdit.splitIpHint')}
                  value={r.ip ?? []}
                  onChange={(v) => patch(i, { ip: v })}
                />
                <Group gap={8} align="flex-end" wrap="nowrap">
                  <Select
                    size="xs"
                    label={t('cascadeEdit.splitTarget')}
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
                      label={t('cascadeEdit.splitDirectionTag')}
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
                    {t('cascadeEdit.removeRule')}
                  </Button>
                </Group>
                {!hasMatcher(r) && (
                  // Saving drops it (a rule with nothing to match on would act as
                  // a catch-all and shadow everything under it), so say that here
                  // rather than let the row quietly disappear on save.
                  <Text size="xs" style={{ color: AMBER }}>
                    {t('cascadeEdit.splitRuleEmpty')}
                  </Text>
                )}
              </Stack>
            </Box>
          ),
        )}

        <Button size="xs" variant="default" onClick={() => setRules([...rules, { ...EMPTY_RULE }])}>
          {t('cascadeEdit.splitAddRule')}
        </Button>

        {preview && <CompiledPreview rules={rules} context={preview} />}

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

/**
 * What the draft actually compiles to, as the node will receive it.
 *
 * Computed by the SERVER, running the same compiler the push runs, because the
 * distance between "category-ru -> direct" and a routing rule is where an
 * operator debugging a split gets stuck - and a second implementation living
 * here would agree with the node right up until it quietly stopped.
 *
 * Collapsed by default: authoring is the common case, and reading xray JSON is
 * what you do when something is wrong.
 */
function CompiledPreview({
  rules,
  context,
}: {
  rules: EgressRule[];
  context: SplitPreviewContext;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Only complete rules go to the API, which refuses a policy the save would
  // also refuse. The rest are counted out loud below rather than dropped.
  const ready = rules.filter(previewable);
  const incomplete = rules.length - ready.length;

  const body = {
    policy: ready,
    ...(context.nodeId ? { nodeId: context.nodeId } : {}),
    position: context.position,
    prevNodeIds: context.prevNodeIds,
    directions: Object.entries(context.outbounds).map(([tag, outbounds]) => ({
      tag: Number(tag),
      outbounds,
    })),
  };

  const query = useQuery({
    // The whole request is the key: the draft IS the question, so any edit is a
    // different question and re-asking it is the point.
    queryKey: ['geo-preview', body],
    queryFn: () => previewGeoPolicy(body),
    enabled: open && ready.length > 0,
    // A preview is a pure function of the draft; nothing on the server moves
    // underneath it except a geo rebuild, which the operator triggers by hand.
    staleTime: 30_000,
    retry: false,
  });

  return (
    <Box style={{ padding: 12, borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}>
      <Group gap={8} wrap="nowrap" align="center">
        <Button size="compact-xs" variant="subtle" style={{ color: MIST }} onClick={() => setOpen(!open)}>
          {open ? `▾ ${t('cascadeEdit.splitPreview')}` : `▸ ${t('cascadeEdit.splitPreview')}`}
        </Button>
        {open && query.isFetching && <Loader size="xs" />}
      </Group>

      {open && (
        <Stack gap={8} style={{ marginTop: 8 }}>
          <Text size="xs" style={{ color: MIST, lineHeight: 1.5 }}>
            {t('cascadeEdit.splitPreviewHint')}
          </Text>

          {incomplete > 0 && (
            <Text size="xs" style={{ color: AMBER }}>
              {t('cascadeEdit.splitPreviewIncomplete', { count: incomplete })}
            </Text>
          )}

          {ready.length === 0 ? (
            <Text size="xs" style={{ color: FAINT }}>
              {t('cascadeEdit.splitPreviewEmpty')}
            </Text>
          ) : query.isError ? (
            <Text size="xs" style={{ color: RED }}>
              {apiErrorMessage(query.error)}
            </Text>
          ) : query.data ? (
            <Stack gap={8}>
              {/* A matcher the node will never see is the single most common
                  reason a split "does nothing", so it leads. */}
              {query.data.dropped.length > 0 && (
                <Text size="xs" style={{ color: AMBER, lineHeight: 1.5 }}>
                  {t('cascadeEdit.splitPreviewDropped', { matchers: query.data.dropped.join(', ') })}
                </Text>
              )}
              {query.data.domainStrategy && (
                <Text size="xs" style={{ color: MIST }}>
                  {t('cascadeEdit.splitPreviewStrategy', { strategy: query.data.domainStrategy })}
                </Text>
              )}
              {/* The node's own egress policy runs BEFORE this split, so a flow
                  matching both takes that one. Shown above the split rules, in
                  the order the node applies them, because the overlap is
                  exactly where an operator's split "does nothing". */}
              {query.data.nodeRules?.length > 0 && (
                <Stack gap={4}>
                  <Text size="xs" style={{ color: AMBER, lineHeight: 1.5 }}>
                    {t('cascadeEdit.splitPreviewNodePolicy', { count: query.data.nodeRules.length })}
                  </Text>
                  <Code
                    block
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      maxHeight: 140,
                      overflow: 'auto',
                      backgroundColor: CARD,
                      color: FAINT,
                    }}
                  >
                    {JSON.stringify(query.data.nodeRules, null, 2)}
                  </Code>
                </Stack>
              )}
              {query.data.rules.length === 0 ? (
                <Text size="xs" style={{ color: AMBER }}>
                  {t('cascadeEdit.splitPreviewNoRules')}
                </Text>
              ) : (
                <Code
                  block
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    maxHeight: 260,
                    overflow: 'auto',
                    backgroundColor: CARD,
                    color: FAINT,
                  }}
                >
                  {JSON.stringify(query.data.rules, null, 2)}
                </Code>
              )}
            </Stack>
          ) : null}
        </Stack>
      )}
    </Box>
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
      title={t('cascadeEdit.split')}
      // Muted until there is something to show: a node without a split is the
      // ordinary case, and an accent on every row would read as a warning.
      style={{ flexShrink: 0, ...(count > 0 ? {} : { color: FAINT }) }}
    >
      {count > 0 ? `geo ${count}` : 'geo'}
    </Button>
  );
}
