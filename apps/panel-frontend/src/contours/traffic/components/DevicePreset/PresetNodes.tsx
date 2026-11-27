import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Box, Text, UnstyledButton } from '@mantine/core';
import { AMBER, CYAN, DISPLAY, FAINT, HAIRLINE, MIST, MONO, MOSS, RED, SNOW, WELL } from '@/contours/traffic/lib/colors';
import { heldNames } from '@/contours/traffic/lib/presetRefusal';
import { nodeDnsMark, summarizePresetNodes, type NodeDnsMark } from '@/contours/traffic/lib/presetNodes';
import { NEW_PRESET_ID } from '@/contours/traffic/lib/devicePresets';
import { getPresetNodes, type DnsSkippedRule, type PresetNode, type PresetNodes, type RoutingPreset } from '@/lib/domain/routePolicies';
import { getSettings } from '@/lib/domain/settings';
import { apiErrorMessage } from '@/lib/net/client';

/** The list stops here: a built-in preset reaches every node, and a fleet is long. */
const LIST_CAP = 50;

type T = (key: string, vars?: Record<string, unknown>) => string;

const LABEL = { fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: MIST } as const;
const NOTE = { fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT } as const;

/**
 * Which nodes get the DNS rules of the preset and in what state (19.12). A
 * summary first, the list of nodes folded under it; the two warnings that
 * hold for every preset stay in view.
 *
 * The list is of the SAVED preset: its nodes do not depend on what is typed,
 * and a new preset has none until it is given to someone.
 */
export function PresetNodes({ preset, dirty }: { preset: RoutingPreset; dirty: boolean }) {
  const { t } = useTranslation();
  const isNew = preset.id === NEW_PRESET_ID;
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['routing-presets', preset.id, 'nodes'], queryFn: () => getPresetNodes(preset.id), enabled: !isNew });
  const data = query.data;
  // A built-in has no rules of its own: what goes to the nodes is the panel's.
  const settings = useQuery({ queryKey: ['settings', 'all'], queryFn: getSettings, enabled: data?.scope === 'panel' });
  const rules = data?.scope === 'panel' ? (settings.data?.subscriptionDnsRules ?? []) : preset.dnsRules;
  const ruleName = (s: DnsSkippedRule) => {
    const r = rules[s.index];
    return r ? r.match.slice(0, 3).join(' ') + (r.match.length > 3 ? ' …' : '') : `#${s.index + 1}`;
  };

  return (
    <Box style={{ paddingBlock: 12, paddingInline: 24, borderTop: `1px solid ${HAIRLINE}` }}>
      <Text style={LABEL}>{t('routes.nodesTitle')}</Text>
      <Text style={NOTE}>{t('routes.nodesAllClients')}</Text>
      <Text style={NOTE}>{t('routes.nodesQueryPreset')}</Text>

      {isNew ? (
        <Text style={{ ...NOTE, marginTop: 6 }}>{t('routes.nodesNew')}</Text>
      ) : query.isError ? (
        <Text style={{ ...NOTE, marginTop: 6, color: RED }}>{apiErrorMessage(query.error)}</Text>
      ) : !data ? (
        <Text style={{ ...NOTE, marginTop: 6 }}>{t('common.loading')}</Text>
      ) : (
        <Body list={data} rules={rules.length} dirty={dirty} open={open} setOpen={setOpen} t={t} ruleName={ruleName} />
      )}
    </Box>
  );
}

function Body({
  list,
  rules,
  dirty,
  open,
  setOpen,
  t,
  ruleName,
}: {
  list: PresetNodes;
  rules: number;
  dirty: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  t: T;
  ruleName: (s: DnsSkippedRule) => string;
}) {
  const s = summarizePresetNodes(list);
  const panel = list.scope === 'panel';
  const leftOut = list.nodes.filter((n) => n.skipped.some((k) => k.kind === 'conflict' || k.kind === 'limit'));

  if (rules === 0) {
    return <Text style={{ ...NOTE, marginTop: 6 }}>{panel ? t('routes.nodesPanelNone') : t('routes.nodesNoRules')}</Text>;
  }
  if (s.nodes === 0) {
    return <Text style={{ ...NOTE, marginTop: 6 }}>{t('routes.nodesNobody')}</Text>;
  }

  const lines: { tone: string; text: string }[] = [
    { tone: SNOW, text: panel ? t('routes.nodesSummaryPanel', { count: s.nodes }) : t('routes.nodesSummary', { receiving: s.receiving, count: s.nodes }) },
    ...(s.waiting > 0 ? [{ tone: MIST, text: t('routes.nodesWaiting', { count: s.waiting }) }] : []),
    ...(s.notExecuting > 0 ? [{ tone: RED, text: t('routes.nodesNotExecuting', { count: s.notExecuting }) }] : []),
    ...(s.partial > 0 ? [{ tone: AMBER, text: t('routes.nodesPartial', { count: s.partial }) }] : []),
    ...(s.unknown > 0 ? [{ tone: MIST, text: t('routes.nodesUnknown', { count: s.unknown }) }] : []),
    ...(s.serverKind > 0 ? [{ tone: AMBER, text: t('routes.nodesServerKind', { count: s.serverKind }) }] : []),
    ...(s.overridden > 0 ? [{ tone: AMBER, text: t('routes.nodesOverridden', { count: s.overridden }) }] : []),
  ];

  return (
    <Box style={{ marginTop: 6 }}>
      {lines.map((l) => (
        <Text key={l.text} style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '17px', color: l.tone }}>
          {l.text}
        </Text>
      ))}
      {dirty && <Text style={NOTE}>{t('routes.nodesSavedOnly')}</Text>}
      <Text style={NOTE}>{t('routes.nodesSentHint')}</Text>

      {/* A rule the node did not get because of a conflict a change of squads made. Not a refusal: the save is not blocked. */}
      {leftOut.length > 0 && (
        <Box style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, backgroundColor: `${AMBER}0F`, border: `1px solid ${AMBER}33` }}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '17px', color: AMBER }}>
            {t('routes.nodesLeftOut', { count: leftOut.length, names: heldNames(leftOut.map((n) => n.name), leftOut.length, t) })}
          </Text>
          {leftOut.map((n) => (
            <Text key={n.id} style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '16px', color: SNOW }}>
              {n.name}: {n.skipped.filter((k) => k.kind === 'conflict' || k.kind === 'limit').map((k) => skippedWords(k, ruleName(k), t)).join('; ')}
            </Text>
          ))}
        </Box>
      )}

      <UnstyledButton type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ marginTop: 8 }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: CYAN }}>{open ? t('routes.nodesHide') : t('routes.nodesShow', { count: s.nodes })}</Text>
      </UnstyledButton>
      {open && (
        <Box style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.nodes.slice(0, LIST_CAP).map((n) => (
            <NodeLine key={n.id} node={n} ruleName={ruleName} t={t} />
          ))}
          {list.nodes.length > LIST_CAP && <Text style={NOTE}>{t('routes.nodesMore', { count: list.nodes.length - LIST_CAP })}</Text>}
        </Box>
      )}
    </Box>
  );
}

function NodeLine({ node, ruleName, t }: { node: PresetNode; ruleName: (s: DnsSkippedRule) => string; t: T }) {
  const mark = node.carried > 0 ? nodeDnsMark(node) : null;
  const state = node.state === 'sent' ? { tone: MOSS, text: t('routes.nodeSent') } : node.state === 'waiting' ? { tone: AMBER, text: t('routes.nodeWaiting') } : { tone: FAINT, text: t('routes.nodeNone') };
  return (
    <Box style={{ padding: '8px 12px', borderRadius: 8, backgroundColor: WELL, border: `1px solid ${HAIRLINE}` }}>
      <Box style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Link to={`/nodes/${node.id}#dns`} style={{ fontFamily: DISPLAY, fontSize: 12, color: CYAN, textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {node.name}
        </Link>
        <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: state.tone }}>{state.text}</Text>
        {mark && mark !== 'executes' && (
          <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: markTone(mark) }}>{markWords(mark, t)}</Text>
        )}
      </Box>
      {node.skipped.map((k) => (
        <Text key={`${k.index}-${k.kind}`} style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '16px', color: FAINT }}>
          {skippedWords(k, ruleName(k), t)}
        </Text>
      ))}
    </Box>
  );
}

function markTone(mark: NodeDnsMark): string {
  return mark === 'not-executes' ? RED : mark === 'partial' ? AMBER : MIST;
}

function markWords(mark: NodeDnsMark, t: T): string {
  switch (mark) {
    case 'not-executes':
      return t('routes.nodeMark.notExecutes');
    case 'partial':
      return t('routes.nodeMark.partial');
    case 'unknown':
      return t('routes.nodeMark.unknown');
    case 'executes':
      return '';
  }
}

/** The sentence for a rule that is not in force on a node. Literal keys. */
function skippedWords(k: DnsSkippedRule, rule: string, t: T): string {
  switch (k.kind) {
    case 'server-kind':
      return t('routes.skipServerKind', { rule });
    case 'manual':
      return t('routes.skipManual', { rule, names: (k.names ?? []).join(', ') });
    case 'limit':
      return t('routes.skipLimit', { rule });
    case 'conflict':
      // null: the panel-wide rules; '': a preset that is gone since the record was made.
      if (k.otherPreset === null || k.otherPreset === undefined) return t('routes.skipConflictPanel', { rule, names: (k.names ?? []).join(', ') });
      if (k.otherPreset === '') return t('routes.skipConflictGone', { rule, names: (k.names ?? []).join(', ') });
      return t('routes.skipConflict', { rule, names: (k.names ?? []).join(', '), preset: k.otherPreset });
  }
}
