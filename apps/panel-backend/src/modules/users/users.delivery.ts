import type { RoutingPresetId } from '@iceslab/shared';
import {
  PRESET_COLUMNS_SELECT,
  presetOf,
  resolveSquadPreset,
  type ResolvedPreset,
} from '../routing-presets/routing-presets.resolve.js';
import { prisma } from '../../prisma.js';
import { getSubscriptionSettings } from '../settings/settings.service.js';
import { matchRuleForUserAgent } from '../srr/srr.service.js';

/**
 * What this user actually gets, as opposed to what is written on their row.
 *
 * Both halves of the answer are computed at serve time out of three or four
 * places, and neither is visible anywhere: the routing preset falls through
 * user -> squad -> panel, and the format is chosen per REQUEST from the
 * client's User-Agent. So a card that shows the stored value shows the wrong
 * thing for most users, and an operator debugging "why is this one routed
 * differently" has nothing to look at.
 */

export type RoutingSource = 'user' | 'squad' | 'global';

/** A preset as the card names it: a built-in by its key, an own one by id and
 *  name. */
export interface PresetRef {
  builtIn: boolean;
  id: string;
  name: string;
}

function refOf(p: ResolvedPreset): PresetRef {
  return p.kind === 'builtin' ? { builtIn: true, id: p.id, name: p.id } : { builtIn: false, id: p.id, name: p.name };
}

export interface UserDeliveryDto {
  routing: {
    /** What a request from this user resolves to right now. */
    effective: RoutingPresetId;
    /** Which tier won, so the card can say where to go to change it. */
    source: RoutingSource;
    /** The per-user override, null = inherits. */
    user: RoutingPresetId | null;
    /** The squads' single distinct override, null = none or they disagree. */
    squad: RoutingPresetId | null;
    /**
     * The squads carry MORE than one distinct override.
     *
     * resolveSquadRouting answers null both for "nobody set one" and for "they
     * disagree", which is right for serving (fall through either way) and wrong
     * for a screen: the second case is a misconfiguration an operator wants to
     * see, and it is otherwise indistinguishable from the ordinary case.
     */
    squadConflict: boolean;
    /** The panel-wide default, the floor everything falls through to. */
    global: RoutingPresetId;
    /**
     * A-229: the same tiers with the operator's own presets in them. The four
     * fields above speak only in built-in keys and stay for the screens that
     * read them; where an own preset decides, `effective` there is the
     * built-in it falls back on and these say what is really served.
     */
    effectivePreset: PresetRef;
    userPreset: PresetRef | null;
    squadPreset: PresetRef | null;
  };
  format: {
    /** The format the last real request was answered in, or the panel's
     *  fallback when this user has never fetched their subscription. */
    effective: string;
    /** `srr` = a rule matched the client's User-Agent, `default` = nothing
     *  matched, or the user has never been seen. */
    source: 'srr' | 'default';
    /** Name of the rule that matched, so the operator can open it. */
    ruleName: string | null;
    /** What their client called itself last time. The evidence behind the two
     *  fields above; without it `effective` is unverifiable. */
    lastUserAgent: string | null;
    lastRequestedAt: string | null;
  };
}

/**
 * The format nothing else claims.
 *
 * Mirrors the last rung of the route handler's chain (explicit ?format=, then
 * an SRR rule, then the Accept heuristic, then this): a client that names
 * neither a format nor a recognised User-Agent gets the universal base64 list.
 */
const FALLBACK_FORMAT = 'plain';

export async function getUserDelivery(userId: string): Promise<UserDeliveryDto | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      ...PRESET_COLUMNS_SELECT,
      groupMembers: { select: { group: { select: PRESET_COLUMNS_SELECT } } },
    },
  });
  if (!user) return null;

  const [settings, lastRequest] = await Promise.all([
    getSubscriptionSettings(),
    // The newest row of the audit trail the subscription route already writes.
    // Indexed on (userId, requestedAt desc), so this is a one-row lookup.
    prisma.subscriptionRequestHistory.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: { userAgent: true, requestedAt: true },
    }),
  ]);

  // The same resolution the subscription makes (routing-presets.resolve.ts),
  // so the card cannot say one thing while the client is handed another.
  const { preset: squadPreset, conflict } = resolveSquadPreset(user.groupMembers.map((m) => m.group));
  const userPreset = presetOf(user);
  const effectivePreset: ResolvedPreset = userPreset ?? squadPreset ?? { kind: 'builtin', id: settings.routingPreset };
  const source: RoutingSource = userPreset ? 'user' : squadPreset ? 'squad' : 'global';
  const builtinKey = (p: ResolvedPreset | null): RoutingPresetId | null => (p?.kind === 'builtin' ? p.id : null);
  const own = builtinKey(userPreset);
  const squad = builtinKey(squadPreset);
  // An own preset is its rules over proxy-all (the format builders' base).
  const effective: RoutingPresetId = effectivePreset.kind === 'builtin' ? effectivePreset.id : 'proxy-all';

  const rule = await matchRuleForUserAgent(lastRequest?.userAgent);

  return {
    routing: {
      effective,
      source,
      user: own,
      squad,
      squadConflict: conflict,
      global: settings.routingPreset,
      effectivePreset: refOf(effectivePreset),
      userPreset: userPreset ? refOf(userPreset) : null,
      squadPreset: squadPreset ? refOf(squadPreset) : null,
    },
    format: {
      effective: rule?.format ?? FALLBACK_FORMAT,
      source: rule ? 'srr' : 'default',
      ruleName: rule?.name ?? null,
      lastUserAgent: lastRequest?.userAgent ?? null,
      lastRequestedAt: lastRequest?.requestedAt.toISOString() ?? null,
    },
  };
}
