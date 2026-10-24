import type { PolicyDrawing, PolicyRule } from '@/lib/domain/nodePolicies';

/** observedAt is written on a change and every 10 min (BACK): older than 15 min is «not seen for a while». */
export const POLICY_SEEN_STALE_MS = 15 * 60_000;

export interface RuleRef {
  ruleId: string;
  /** «#3 geosite:ads» when the rule is in the loaded policy; null when it is not. */
  label: string | null;
}

/**
 * What the node page says about the policy as it reaches the node (A-232).
 *
 *   panel     the rules the push leaves out, with their reason code, by the
 *             drawing the panel SENDS;
 *   agent     what the node's xray reports it drew. `null`: the agent does not
 *             report (an older agent, or not asked yet), never «all goes out»;
 *             `mismatch` when it drew another drawing than was sent; its
 *             rules not drawn by id, and the exits no rule of the current
 *             policy names (`orphanExits`);
 *   stale     the report was last seen over 15 minutes ago.
 */
export interface PolicyDrawingView {
  sent: PolicyDrawing['drawing'];
  panelNotDrawn: (RuleRef & { reason: string })[];
  agent: {
    drawing: PolicyDrawing['drawing'];
    mismatch: boolean;
    notDrawn: RuleRef[];
    orphanExits: { exit: string; direction: number }[];
    renderedAt: string;
    observedAt: string;
    stale: boolean;
  } | null;
}

export function ruleLabel(rule: Pick<PolicyRule, 'position' | 'match'> | undefined): string | null {
  if (!rule) return null;
  const m = rule.match;
  const first = [...m.domain, ...m.ip, ...(m.port ? [`port:${m.port}`] : []), ...m.protocol][0];
  return `#${rule.position + 1}${first ? ` ${first}` : ''}`;
}

export function policyDrawingView(
  d: PolicyDrawing,
  rules: readonly Pick<PolicyRule, 'id' | 'position' | 'match'>[] | undefined,
  now: number,
): PolicyDrawingView {
  const byId = new Map((rules ?? []).map((r) => [r.id, r]));
  const ref = (ruleId: string): RuleRef => ({ ruleId, label: ruleLabel(byId.get(ruleId)) });
  const a = d.agent;
  return {
    sent: d.drawing,
    panelNotDrawn: d.notDrawn.map((n) => ({ ...ref(n.ruleId), reason: n.reason })),
    agent: a
      ? {
          drawing: a.drawing,
          mismatch: a.drawing !== d.drawing,
          notDrawn: a.notDrawn.flatMap((n) => n.ruleIds).filter((id, i, all) => all.indexOf(id) === i).map(ref),
          orphanExits: a.notDrawn.filter((n) => n.ruleIds.length === 0).map((n) => ({ exit: n.exit, direction: n.direction })),
          renderedAt: a.renderedAt,
          observedAt: a.observedAt,
          stale: now - Date.parse(a.observedAt) > POLICY_SEEN_STALE_MS,
        }
      : null,
  };
}

/** The reason's words key, or null for a reason this build does not know (said as its code). */
export function notDrawnReasonKey(reason: string): string | null {
  return reason === 'lost-condition' || reason === 'direction-not-dialled' || reason === 'no-cascade-drawing'
    ? `nodeEdit.policyDrawing.reason.${reason}`
    : null;
}
