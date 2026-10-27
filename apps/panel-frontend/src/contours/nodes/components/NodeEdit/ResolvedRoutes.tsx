import type { Node } from '@/lib/domain/nodes';
import type { Cascade } from '@/lib/domain/cascades';
import type { RoutePolicy } from '@/lib/domain/routePolicies';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChainIcon, CircleMinusIcon, LockIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { RoutesHeader } from '@/contours/nodes/components/NodeEdit/RoutesHeader';
import { RuleRow } from '@/contours/nodes/components/NodeEdit/RuleRow';
import { TableHead } from '@/contours/nodes/components/NodeEdit/RoutesTableHead';
import { TagButton } from '@/contours/nodes/components/NodeEdit/TagButton';
import { AMBER, CARD, CYAN, DIM, DISPLAY, EDGE, FAINT, HAIRLINE, MIST, MONO, MOSS, RED, SNOW, VIOLET, WELL } from '@/contours/nodes/lib/colors';
import { Box, Text } from '@mantine/core';
import { WarnIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { LoadFailed, LoadFailedLine } from '@/ui/LoadFailed';
import type { LoadFailure } from '@/lib/ui/loadView';
import { getPolicyDrawing, type PolicyActionKind } from '@/lib/domain/nodePolicies';
import { apiErrorMessage } from '@/lib/net/client';
import { policyDrawingLoad } from '@/contours/nodes/lib/policyDrawing';
import { nodePolicyBand, routeRows, type PolicyBand, type RouteRow } from '@/contours/nodes/lib/routeRows';

/** Each node-policy action keeps the colour the policy editor gives it. */
const POLICY_TONE: Record<PolicyActionKind, string> = { block: RED, direct: MOSS, warp: VIOLET, cascade: CYAN };

export function ResolvedRoutes({
  node,
  cascade,
  isBalancerEntry,
  policies,
  egressLabel,
  nodePoliciesQuery,
  cascadeUnknown = false,
  cascadeFailure = null,
  policiesFailure = null,
}: {
  node: Node;
  cascade: { cascade: Cascade; role: string; directions: string[] } | null;
  isBalancerEntry: boolean;
  policies: { policy: RoutePolicy; squads: string[] }[];
  egressLabel: string;
  /** The node policies list: the node's own policy is read from it (A-263). */
  nodePoliciesQuery: { data: unknown; isError: boolean; error: unknown; refetch: () => unknown };
  /** The cascade list has not arrived: «outside every cascade» cannot be said. */
  cascadeUnknown?: boolean;
  cascadeFailure?: LoadFailure | null;
  /** A list the reachable policies come from did not arrive. */
  policiesFailure?: LoadFailure | null;
}) {
  const { t } = useTranslation();
  // Tag 0 is the plain profile every user gets; the rest are granted policies.
  const [tag, setTag] = useState(0);
  // The same request and cache as the policy lines on the Parameters tab.
  const drawingQuery = useQuery({
    queryKey: ['policy-drawing', node.id],
    queryFn: () => getPolicyDrawing(node.id),
    retry: false,
    enabled: Boolean(node.policyId),
  });
  const drawingLoad = policyDrawingLoad(drawingQuery, apiErrorMessage);

  if (!cascade && cascadeUnknown) {
    return cascadeFailure ? (
      <LoadFailed message={cascadeFailure.message} onRetry={cascadeFailure.onRetry} />
    ) : (
      <Box style={{ padding: 40, borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 13, color: FAINT, textAlign: 'center' }}>{t('common.loading')}</Text>
      </Box>
    );
  }

  const nodePolicy = nodePolicyBand(
    node.policyId,
    nodePoliciesQuery,
    drawingLoad.kind === 'ready' ? drawingLoad.drawing : null,
    apiErrorMessage,
  );
  const active = isBalancerEntry ? (policies.find((p) => p.policy.ordinal === tag) ?? null) : null;
  const rows = routeRows({ role: cascade?.role ?? null, isBalancerEntry, squadPolicy: active, nodePolicy });
  const exits = cascade?.directions ?? [];
  const where = exits.length > 0 ? exits.join(' · ') : '-';
  const policyName = nodePolicy.band.kind === 'ready' ? nodePolicy.band.name : '';

  const bandText = (b: PolicyBand) =>
    b.kind === 'none'
      ? t('nodeEdit.routes.policyNone')
      : b.kind === 'loading'
        ? t('nodeEdit.routes.policyLoading')
        : b.kind === 'missing'
          ? t('nodeEdit.routes.policyMissing')
          : b.kind === 'ready'
            ? b.drawingKnown
              ? t('nodeEdit.routes.policyBand', { name: b.name })
              : `${t('nodeEdit.routes.policyBand', { name: b.name })} · ${t('nodeEdit.routes.policyDrawingUnknown')}`
            : '';

  const row = (r: RouteRow, i: number) => {
    switch (r.kind) {
      case 'quic':
        return (
          <RuleRow key={i} accent={RED} background={WELL} icon={<LockIcon size={13} color={FAINT} />}
            match={t('nodeEdit.routes.quicMatch')} action={t('nodeEdit.routes.quicAction')} why={t('nodeEdit.routes.quicWhy')} muted />
        );
      case 'squadBlock':
      case 'squadDirect':
        return (
          <RuleRow key={i} accent={CYAN} match={r.domains.join(' · ')}
            action={r.kind === 'squadBlock' ? t('nodeEdit.routes.toNowhere') : t('nodeEdit.routes.fromOurIp')}
            actionDot={r.kind === 'squadBlock' ? RED : MOSS}
            why={t('nodeEdit.routes.source', { policy: r.source.policy, squads: r.source.squads.join(', ') })} />
        );
      case 'squadDead':
        return (
          <RuleRow key={i} accent={AMBER} background={`${AMBER}0D`} icon={<WarnIcon size={14} color={AMBER} />}
            match={r.domains.join(' · ')} action={t('nodeEdit.routes.fromOurIp')} why={t('nodeEdit.routes.deadWhy')} whyTone={AMBER} struck />
        );
      case 'policyBand':
        // Never silence: no policy is «-», a failed list is a retry line.
        return (
          <Box key={i} style={{ padding: '10px 20px', borderTop: `1px solid ${HAIRLINE}`, backgroundColor: WELL }}>
            {r.band.kind === 'failed' ? (
              <LoadFailedLine message={`${t('nodeEdit.routes.policyFailed')}: ${r.band.message}`} onRetry={r.band.onRetry} />
            ) : (
              <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', lineHeight: '14px', textTransform: 'uppercase', color: MIST }}>
                {bandText(r.band)}
              </Text>
            )}
          </Box>
        );
      case 'policyRule': {
        const action =
          r.rule.action === 'cascade'
            ? t('nodeEdit.routes.policyAction.cascade', { direction: r.rule.direction ?? '-' })
            : t(`nodeEdit.routes.policyAction.${r.rule.action}`);
        const match = r.rule.match.length > 0 ? r.rule.match.join(' · ') : t('nodeEdit.routes.policyAny');
        return r.rule.notDrawn ? (
          <RuleRow key={i} accent={AMBER} background={`${AMBER}0D`} icon={<WarnIcon size={14} color={AMBER} />}
            match={match} action={action}
            why={
              // A-277: nobody of this entry may take the direction.
              r.rule.notDrawnReason === 'nobody-may-take'
                ? t('nodeEdit.routes.policyNobodyMayTake')
                : t('nodeEdit.routes.policyNotDrawn', { name: policyName })
            }
            whyTone={AMBER} struck />
        ) : (
          <RuleRow key={i} accent={CYAN} match={match} action={action} actionDot={POLICY_TONE[r.rule.action]}
            why={
              r.rule.ungated
                ? `${t('nodeEdit.routes.policyWhy', { name: policyName })}. ${t('nodeEdit.routes.policyUngated')}`
                : t('nodeEdit.routes.policyWhy', { name: policyName })
            }
            whyTone={r.rule.ungated ? AMBER : undefined} />
        );
      }
      case 'fromLink':
        return (
          <RuleRow key={i} accent={MOSS} background={WELL} icon={<ChainIcon size={13} color={FAINT} />}
            match={t('nodeEdit.routes.fromLink')}
            action={r.role === 'exit' ? t('nodeEdit.routes.fromOurIp') : t('nodeEdit.routes.toDirection', { where })}
            actionDot={r.role === 'exit' ? MOSS : VIOLET}
            why={t(`nodeEdit.routes.why.${r.role}`, { cascade: cascade?.cascade.name ?? '' })} />
        );
      case 'catchAll':
        if (r.to === 'nothing') {
          return (
            <RuleRow key={i} accent={DIM} icon={<CircleMinusIcon size={14} color={FAINT} />}
              match={t('nodeEdit.routes.everythingElse')} matchStrong action={t('nodeEdit.routes.nothingElse')}
              why={t('nodeEdit.routes.nothingElseWhy')} muted />
          );
        }
        if (r.to === 'egress') {
          return (
            <RuleRow key={i} accent={MOSS} background={WELL} icon={<CircleMinusIcon size={14} color={FAINT} />}
              match={t('nodeEdit.routes.everythingElse')} matchStrong action={egressLabel} actionDot={MOSS}
              why={t('nodeEdit.routes.defaultWhy')} />
          );
        }
        if (r.to === 'direction') {
          return (
            <RuleRow key={i} accent={MOSS} background={WELL} icon={<CircleMinusIcon size={14} color={FAINT} />}
              match={t('nodeEdit.routes.everythingElse')} matchStrong action={t('nodeEdit.routes.toDirection', { where })}
              actionDot={VIOLET} why={t('nodeEdit.routes.why.chainEntry', { cascade: cascade?.cascade.name ?? '' })} />
          );
        }
        // The catch-all of a balancer entry. Which exit it lands on is the node's own door.
        return (
          <RuleRow key={i} accent={MOSS} background={WELL} icon={<CircleMinusIcon size={14} color={FAINT} />}
            match={t('nodeEdit.routes.everythingElse')} matchStrong why={t('nodeEdit.routes.defaultWhy')}
            actionBox={
              <Box style={{ display: 'flex', alignItems: 'center', gap: 9, height: 34, paddingInline: 12, borderRadius: 8, backgroundColor: CARD, border: `1px solid ${EDGE}`, width: 250, flexShrink: 0 }}>
                <Box style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: VIOLET, flexShrink: 0 }} />
                <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, lineHeight: '16px', color: SNOW }}>
                  {exits.length === 1 ? t('nodeEdit.routes.exitOne', { name: exits[0]! }) : t('nodeEdit.routes.exitMany', { count: exits.length })}
                </Text>
              </Box>
            }
          />
        );
    }
  };

  return (
    <Box style={{ borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}`, overflow: 'hidden' }}>
      <RoutesHeader node={node} role={cascade?.role ?? 'none'} balancer={isBalancerEntry} />
      {isBalancerEntry && policiesFailure && (
        <Box style={{ padding: '10px 20px', borderBottom: `1px solid ${HAIRLINE}` }}>
          <LoadFailedLine message={policiesFailure.message} onRetry={policiesFailure.onRetry} />
        </Box>
      )}
      {/* One node carries every set; the tag in the client's UUID picks one. */}
      {isBalancerEntry && (
        <Box style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: `1px solid ${HAIRLINE}` }}>
          <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '0.12em', lineHeight: '12px', textTransform: 'uppercase', color: FAINT, flexShrink: 0 }}>
            {t('nodeEdit.routes.showFor')}
          </Text>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TagButton active={tag === 0} onClick={() => setTag(0)} label={t('nodeEdit.routes.plain')} tag={0} />
            {policies.map(({ policy }) => (
              <TagButton key={policy.id} active={tag === policy.ordinal} onClick={() => setTag(policy.ordinal)} label={policy.name} tag={policy.ordinal} />
            ))}
          </Box>
          <Box style={{ flex: 1 }} />
          <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: FAINT }}>{t('nodeEdit.routes.switchHint')}</Text>
        </Box>
      )}
      <TableHead />
      {rows.map(row)}
    </Box>
  );
}
