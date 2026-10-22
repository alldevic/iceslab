import type { LoadFailure } from '@/lib/ui/loadView';

/**
 * The subscription link a screen may hand out, or why it may not (spec
 * frontend-users, A-207). Origin and path prefix both come from
 * /api/auth/status, which since A-171 (742eeffd) gives the host the operator
 * set in the panel first; the screen only puts the token after them, the way
 * the server prints the same link (subscription.link.ts `subscriptionUrl`).
 * No host of its own and no `/sub` of its own: a wrong link copied to a
 * client is worse than none.
 *
 *   ready: the link;
 *   loading: status has not answered;
 *   failed: status did not come, with a retry;
 *   absent: status came without an address (a server older than the key, or
 *     an empty one): an incomplete fact, so no link either.
 */
export type SubscriptionLink =
  | { kind: 'ready'; url: string }
  | { kind: 'loading' }
  | { kind: 'absent' }
  | ({ kind: 'failed' } & LoadFailure);

export function subscriptionLink(
  token: string,
  status: {
    data?: { panel?: { publicUrl?: unknown; subscriptionPathPrefix?: unknown } } | undefined;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  say: (err: unknown) => string,
): SubscriptionLink {
  if (status.data) {
    const panel = status.data.panel;
    const origin = typeof panel?.publicUrl === 'string' ? panel.publicUrl : '';
    const prefix = panel?.subscriptionPathPrefix;
    if (!/^https?:\/\/[^/]/.test(origin) || typeof prefix !== 'string' || !prefix.startsWith('/')) {
      return { kind: 'absent' };
    }
    return { kind: 'ready', url: `${origin}${prefix}/${token}` };
  }
  if (status.isError) return { kind: 'failed', message: say(status.error), onRetry: () => void status.refetch() };
  return { kind: 'loading' };
}
