/**
 * The device limit a user is held to (A-148, BACK 514504e5), read the way the
 * server reads it (hwid.service.ts `effectiveHwidLimit`). The user's own value
 * has three meanings:
 *   null / ''  as the squads say: the largest positive squad limit, none when
 *              no squad sets one (`resolveSquadHwidLimit`);
 *   0          an explicit no-limit over any squad: devices are recorded,
 *              never blocked;
 *   N >= 1     the limit.
 *
 * `squadLimits` null: the squad list did not arrive, so an inherited limit is
 * unknown, not «no limit» (an incomplete fact is not a fact).
 */
export type DeviceCap =
  | { kind: 'limit'; limit: number; from: 'user' | 'squad' }
  | { kind: 'none'; from: 'user' | 'squad' }
  | { kind: 'unknown' };

export function effectiveDeviceCap(
  userLimit: number | '' | null | undefined,
  squadLimits: readonly (number | null | undefined)[] | null,
): DeviceCap {
  if (userLimit === 0) return { kind: 'none', from: 'user' };
  if (typeof userLimit === 'number' && userLimit >= 1) return { kind: 'limit', limit: userLimit, from: 'user' };
  if (squadLimits === null) return { kind: 'unknown' };
  const set = squadLimits.filter((n): n is number => typeof n === 'number' && n > 0);
  return set.length > 0 ? { kind: 'limit', limit: Math.max(...set), from: 'squad' } : { kind: 'none', from: 'squad' };
}

/** The roster cell: the user's own value, «as the squad» for none of their own. */
export function deviceLimitCell(userLimit: number | null | undefined): { kind: 'limit'; limit: number } | { kind: 'none' } | { kind: 'squad' } {
  if (userLimit === 0) return { kind: 'none' };
  if (typeof userLimit === 'number' && userLimit >= 1) return { kind: 'limit', limit: userLimit };
  return { kind: 'squad' };
}
