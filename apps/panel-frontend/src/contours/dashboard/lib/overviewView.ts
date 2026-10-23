/**
 * What «Home» shows for its 30-second overview poll (A-242).
 *
 * Data first: a poll that fails after an answer keeps the screen on the last
 * answer and marks it stale, with when that answer came. The whole screen
 * gives way to the failure only before the first answer. It used to be
 * `isError || !data`, so one failed poll blanked a screen that had numbers.
 */
export type OverviewView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; stale: boolean; updatedAt: string | null };

export function overviewView(q: { data: unknown; isError: boolean; dataUpdatedAt: number }): OverviewView {
  if (q.data === undefined || q.data === null) return q.isError ? { kind: 'failed' } : { kind: 'loading' };
  return {
    kind: 'ready',
    stale: q.isError,
    updatedAt: q.dataUpdatedAt > 0 ? new Date(q.dataUpdatedAt).toISOString() : null,
  };
}

/**
 * The fill of a usage bar, or null when the value is unknown (A-242, k): an
 * unknown disk is drawn as an empty rail next to «-», not as 0 %.
 */
export function usageFill(percent: number | null | undefined): number | null {
  return typeof percent === 'number' && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
}
