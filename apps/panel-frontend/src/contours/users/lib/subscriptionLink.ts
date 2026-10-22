import { subscriptionUrl } from '@/lib/domain/users';
import type { LoadFailure } from '@/lib/ui/loadView';

/**
 * The subscription link a screen may hand out, or why it may not (spec
 * frontend-users). The link is built from the panel's public address in
 * /api/auth/status; while that has not answered, `subscriptionUrl` falls back
 * to the API base, and on a production build that is the wrong host. A wrong
 * link copied to a client is worse than none, so without an answer there is
 * no link: «loading», or «failed» with a retry. Once BACK sends the whole link
 * from status (A-171), this reads it from there.
 */
export type SubscriptionLink =
  | { kind: 'ready'; url: string }
  | { kind: 'loading' }
  | ({ kind: 'failed' } & LoadFailure);

export function subscriptionLink(
  token: string,
  status: {
    data?: { panel?: { publicUrl: string; subscriptionPathPrefix: string } } | undefined;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  say: (err: unknown) => string,
): SubscriptionLink {
  if (status.data) return { kind: 'ready', url: subscriptionUrl(token, status.data.panel) };
  if (status.isError) return { kind: 'failed', message: say(status.error), onRetry: () => void status.refetch() };
  return { kind: 'loading' };
}
