import { config, subscriptionOrigin } from '../../config.js';
import type { PublicUserDto } from '../users/users.mapper.js';

// ───── Enum remaps (iceslab native ⇄ Remnawave wire) ─────

const STRATEGY_TO_REMNA: Record<string, string> = {
  no_reset: 'NO_RESET',
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  rolling: 'MONTH_ROLLING',
};

const STRATEGY_TO_NATIVE: Record<string, 'no_reset' | 'day' | 'week' | 'month' | 'rolling'> = {
  NO_RESET: 'no_reset',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  MONTH_ROLLING: 'rolling',
  // tolerate the aliases Remnawave/minishop normalize client-side
  NONE: 'no_reset',
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
};

/** Remnawave trafficLimitStrategy → native, defaulting unknowns to no_reset. */
export function strategyToNative(
  s: string | undefined,
): 'no_reset' | 'day' | 'week' | 'month' | 'rolling' | undefined {
  if (s === undefined) return undefined;
  return STRATEGY_TO_NATIVE[s.toUpperCase()] ?? 'no_reset';
}

/**
 * Remnawave status → native, for the two statuses the API may set. LIMITED /
 * EXPIRED are lifecycle states the cron owns, so they're ignored as input.
 */
export function statusToNative(s: string | undefined): 'active' | 'disabled' | undefined {
  if (!s) return undefined;
  const up = s.toUpperCase();
  if (up === 'ACTIVE') return 'active';
  if (up === 'DISABLED') return 'disabled';
  return undefined;
}

/**
 * Remnawave trafficLimitBytes → native byte-precise limit. Remnawave uses 0 for
 * unlimited (native null). BYTE-EXACT on purpose: the value is stored verbatim
 * (native has a byte column) and echoed back unchanged, because the minishop
 * re-reads the echoed limit and entitlement-verifies it against the exact byte
 * count it sent with a strict integer compare — any mismatch rolls back the
 * paid activation. Quantizing to whole GiB (the old behaviour) failed that check
 * for every non-GiB-aligned limit: traffic-package carryover (used+purchase),
 * over-quota topups, and fractional-GB tariffs/promos are never 2³⁰-aligned.
 */
export function bytesToNativeLimit(bytes: number | null | undefined): number | null {
  if (bytes == null || bytes <= 0) return null;
  return bytes;
}

/**
 * Remnawave hwidDeviceLimit → native. Remnawave uses 0 (and the shop's
 * USER_HWID_DEVICE_LIMIT=0) for "unlimited devices"; the native schema rejects
 * 0 (.positive()), so <=0 maps to null (unlimited / clear the limit). Mirrors
 * the bytesToGb "0 = unlimited" convention.
 */
export function hwidLimitToNative(v: number | null | undefined): number | null {
  if (v == null || v <= 0) return null;
  return v;
}

/** The client subscription URL for a token (same origin/prefix as /sub). */
export function subscriptionUrlFor(token: string): string {
  return `${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/${token}`;
}

/**
 * Per-request mapping context. `squadNames` resolves groupId → display name;
 * `hiddenGroupIds` are iceslab-internal groups (the seeded "All" squad and the
 * facade's no-access group) that must NOT be echoed in activeInternalSquads —
 * otherwise the minishop captures them as phantom "manual overrides" and re-
 * applies them forever, and the "All" squad silently re-grants full access.
 */
export interface RemnaMapCtx {
  squadNames?: Map<string, string>;
  hiddenGroupIds?: ReadonlySet<string>;
}

/**
 * Native PublicUserDto → Remnawave ExtendedUser (the field subset the minishop
 * reads). `subscriptionToken` is exposed as both `shortUuid` and
 * `subscriptionUuid` (iceslab has no UUID-shaped sub credential — it's the
 * token, used consistently as id and as the /sub URL tail). `squadNames` maps a
 * groupId → its display name for `activeInternalSquads`; a missing name falls
 * back to the id.
 *
 * IDENTITY IS `id`, AND `uuid` IS DELIBERATELY ABSENT. Remnawave 3.0 dropped
 * `uuid` from the user object; the client restores its own historical `uuid` key
 * from the numeric `id` when none is present, but PREFERS a `uuid` that IS
 * present. Echoing our native UUID here would therefore make the client adopt an
 * identifier that its own 3.x guard then refuses to send — every user-scoped
 * call for that subscriber would fail locally, with no request and no error to
 * see. Squad/node/host/subscription ids stay UUIDs: 3.x only renumbered users.
 */
export function mapUserToRemna(
  dto: PublicUserDto,
  ctx: RemnaMapCtx = {},
): Record<string, unknown> {
  const strategy = STRATEGY_TO_REMNA[dto.trafficLimitStrategy] ?? 'NO_RESET';
  const usedBytes = dto.trafficUsedBytes;
  const lifetimeBytes = dto.lifetimeTrafficBytes;
  return {
    // Number, not string: the client validates this as an integer id and a
    // quoted value would read as a 2.x-style reference. Safe — the column is a
    // sequence and parseUserRef bounds it to 2^53.
    id: Number(dto.numericId),
    subscriptionUuid: dto.subscriptionToken,
    shortUuid: dto.subscriptionToken,
    username: dto.username,
    status: dto.status.toUpperCase(),
    // Remnawave: 0 = unlimited (native null)
    trafficLimitBytes: dto.trafficLimitBytes ?? 0,
    trafficLimitStrategy: strategy,
    usedTrafficBytes: usedBytes,
    lifetimeUsedTrafficBytes: lifetimeBytes,
    // Some minishop read-sites take traffic from a nested object, others flat.
    userTraffic: {
      usedTrafficBytes: usedBytes,
      lifetimeUsedTrafficBytes: lifetimeBytes,
      trafficLimitStrategy: strategy,
    },
    expireAt: dto.expireAt,
    // Remnawave: 0 = unlimited (native null) — symmetric with trafficLimitBytes.
    // The minishop's entitlement verify compares its sent 0 against this; null
    // would mismatch and roll back paid activations under the default unlimited-
    // HWID config.
    hwidDeviceLimit: dto.hwidDeviceLimit ?? 0,
    // Telegram IDs are within JS safe-integer range; the minishop reads a number.
    telegramId: dto.telegramId != null ? Number(dto.telegramId) : null,
    email: dto.email,
    // Always emit the key (even when null): the minishop's round-trip verify
    // treats a MISSING key as present=false and rolls back paid activations.
    externalSquadUuid: dto.externalSquadUuid ?? null,
    description: dto.description,
    tag: dto.tag,
    subscriptionUrl: subscriptionUrlFor(dto.subscriptionToken),
    // Always emit the key, null included. The minishop derives a user's
    // connection state from PRESENCE, not value: a payload carrying no
    // connection marker at all reads as `unknown`, one carrying `onlineAt: null`
    // reads as `never`, and only a timestamp reads as `connected`. Omitting it
    // therefore does not degrade gracefully — it collapses "never connected"
    // into "we cannot tell", which is what the admin user page rendered and
    // what emptied the `active_never_connected` broadcast audience, since that
    // segment requires every one of a user's subscriptions to read exactly
    // `never`.
    onlineAt: dto.lastOnlineAt,
    activeInternalSquads: dto.groupIds
      .filter((id) => !ctx.hiddenGroupIds?.has(id))
      .map((id) => ({ uuid: id, name: ctx.squadNames?.get(id) ?? id })),
    createdAt: dto.createdAt,
  };
}
