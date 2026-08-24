import { eventBus } from '../../lib/event-bus.js';
import { emitRemnaWebhookForUser, isRemnaWebhookConfigured } from './remnawave.webhook.js';

/**
 * Hook A — emit `user.expired` when the lifecycle cron flips a user active →
 * expired. Piggybacks the existing `user.status-changed` event (no call-site
 * change). Filter on `to === 'expired'` (the `to === 'limited'` transition from
 * findExceededTrafficUsers must be excluded). No dedup needed: findExpiredUsers
 * flips before emitting, so a cycle fires once.
 *
 * The row is loaded inside the emitter, not here: this handler runs once per
 * user in a batch that can be the whole month-boundary cohort, and reading the
 * row here would take a Prisma connection per user before the emitter's
 * semaphore ever saw them.
 *
 * The `user.expires_in_{72,48,24}_hours` events come from the separate cron scan
 * (scanRemnaExpiryNotifications) — there is no native "upcoming expiry" event.
 */
export function registerRemnawaveWebhookEmitter(): void {
  eventBus.on('user.status-changed', (payload) => {
    if (payload.to !== 'expired') return;
    if (!isRemnaWebhookConfigured()) return;
    emitRemnaWebhookForUser('user.expired', payload.userId);
  });
}
