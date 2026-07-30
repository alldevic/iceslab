/**
 * How recently a user must have moved bytes to count as online.
 *
 * `user_traffic.online_at` is refreshed by the stats poll only for users with a
 * non-zero delta in that tick, so "online" here means "passed traffic recently",
 * not "holds an open tunnel". Nodes report counters, not sessions, so that is
 * the strongest thing we can honestly claim.
 *
 * It lives in shared because the panel answers the same question in three
 * places and used to answer it differently: the dashboard counted a 3-minute
 * window while the user list glowed for 5, so a user last seen four minutes ago
 * was online in the roster and absent from "Online now" on the same screen.
 *
 * Five minutes, not three: a connected client that happens to be idle moves no
 * bytes, and at three minutes it flickers offline while the tunnel is up. Five
 * covers an ordinary pause between requests. Raising it further would start
 * calling genuinely disconnected people online, which is the worse error, an
 * operator chasing a user who is not there.
 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** Whether a last-seen timestamp falls inside the online window. */
export function isOnlineAt(
  lastOnlineAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  if (!lastOnlineAt) return false;
  const seen =
    typeof lastOnlineAt === 'string' ? Date.parse(lastOnlineAt) : lastOnlineAt.getTime();
  if (Number.isNaN(seen)) return false;
  return nowMs - seen < ONLINE_WINDOW_MS;
}
