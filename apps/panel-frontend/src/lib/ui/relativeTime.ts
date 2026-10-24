import { ONLINE_WINDOW_MS } from '@iceslab/shared';

export type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** `fresh` means inside the online window, so a caller can colour on presence
 *  without recomputing it. Callers that only need the words ignore it. */
export type RelativeTone = 'fresh' | 'stale' | 'never' | 'unknown';

/**
 * How long ago a timestamp was, in words.
 *
 * Floored at every step, so "ago" means "at least this long" rather than
 * "roughly". Rounding used to put the label ahead of the threshold it sits
 * next to: at 4m50s the text already read 5m while the presence dot was still
 * filled, and at 5m00s the same words sat beside a hollow one. Identical
 * wording on opposite sides of the line reads as a broken dot, not as a
 * rounding rule. It also made half an hour print as "1h ago".
 *
 * Two screens ask this question and used to answer it in their own copies, one
 * of which never reached i18n and answered in English on a Russian panel.
 *
 * NOT the shape for a countdown: flooring "expires in 20 hours" would give
 * "in 0 days", which is worse than being approximate, so `expireRelative` in
 * UsersPage keeps its own rounding. And not the shape for the cascade page,
 * which says "just now" under a minute instead of counting seconds. That is
 * right for a config push and would need a flag here, which would cost more
 * than the duplication it removes.
 *
 * The input is checked first. `null` is the server saying the event never
 * happened, so it reads «never». A string that does not parse is not a time
 * at all: «-», not «NaN ago». A time ahead of the clock (the server's clock
 * runs ahead of the browser's) is «0 s ago», not a negative count.
 */
export function relativeTime(
  iso: string | null,
  t: TFn,
): { text: string; tone: RelativeTone } {
  if (iso === null) return { text: t('userTime.never'), tone: 'never' };
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return { text: '-', tone: 'unknown' };
  const diffMs = Math.max(0, Date.now() - at);
  const sec = Math.floor(diffMs / 1000);
  // The same window the presence dot and the dashboard's "online now" use, so
  // none of the three can disagree about the same user.
  const tone: RelativeTone = diffMs < ONLINE_WINDOW_MS ? 'fresh' : 'stale';
  if (sec < 60) return { text: t('userTime.sAgo', { n: sec }), tone };
  const min = Math.floor(sec / 60);
  if (min < 60) return { text: t('userTime.mAgo', { n: min }), tone };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { text: t('userTime.hAgo', { n: hr }), tone };
  const days = Math.floor(hr / 24);
  return { text: t('userTime.dAgo', { n: days }), tone };
}
