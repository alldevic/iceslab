import type { ProtocolCredentials } from '@iceslab/shared';

/**
 * What the node is told of a user's term and traffic limit, for the
 * `mtprotoproxy` engine's own backstop (the node cuts the user off by itself
 * when the panel cannot reach it). The panel's accounting and its removeUser
 * stay the primary mechanism; these fields only bound the gap.
 *
 * The quota goes out as what is LEFT of the user's limit (limit minus used,
 * never below 0), not as the limit: the engine counts only its own traffic from
 * zero at each process start, and the used volume is the panel's across all
 * protocols. 0 is a limit spent, so `undefined` (no key at all) is the only way
 * to say "no limit". A user with neither limit nor term gets neither field.
 */
export function mtprotoBackstop(user: {
  expireAt: Date | null;
  trafficLimitBytes: bigint | null;
  traffic?: { usedTrafficBytes: bigint } | null;
}): Pick<ProtocolCredentials, 'mtprotoExpiresAt' | 'mtprotoQuotaBytes'> {
  const out: Pick<ProtocolCredentials, 'mtprotoExpiresAt' | 'mtprotoQuotaBytes'> = {};
  if (user.expireAt) out.mtprotoExpiresAt = user.expireAt.toISOString();
  if (user.trafficLimitBytes !== null) {
    const left = user.trafficLimitBytes - (user.traffic?.usedTrafficBytes ?? 0n);
    out.mtprotoQuotaBytes = Number(left > 0n ? left : 0n);
  }
  return out;
}
