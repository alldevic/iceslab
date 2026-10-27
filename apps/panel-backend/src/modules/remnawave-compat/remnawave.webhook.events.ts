import { eventBus } from '../../lib/infra/event-bus.js';
import { emitRemnaWebhookForUser, isRemnaWebhookConfigured } from './remnawave.webhook.js';

/**
 * Remnawave-format webhooks, a second listener on the same domain events the
 * K2 bus (modules/webhooks) forwards. Different body, signature and target, so
 * a separate sender; the same events, so no call site knows about the facade.
 *
 * The row is loaded inside the emitter, not here: these handlers run once per
 * user in a batch that can be the whole month-boundary cohort, and reading the
 * row here would take a Prisma connection per user before the emitter's
 * semaphore ever saw them.
 *
 * `user.expires_in_{72,48,24}_hours` have no domain event; the scheduler's
 * remnawave-expiry-notify job scans for them (scanRemnaExpiryNotifications).
 */
export function registerRemnawaveWebhookEmitter(): void {
  // The expiry cron flips active → expired and emits this once per flip. The
  // `limited` transition (traffic cap) is not an expiry and is not sent.
  eventBus.on('user.status-changed', (payload) => {
    if (payload.to !== 'expired') return;
    if (!isRemnaWebhookConfigured()) return;
    emitRemnaWebhookForUser('user.expired', payload.userId);
  });

  // Remnawave sends `user_hwid_devices.added` when a device row is created; a
  // shop that knows it tells the user a new device appeared and offers a
  // device top-up at the limit.
  eventBus.on('hwid.device-added', (payload) => {
    if (!isRemnaWebhookConfigured()) return;
    emitRemnaWebhookForUser(
      'user_hwid_devices.added',
      payload.userId,
      {},
      {
        // Remnawave's own key (`data: { user, hwidUserDevice }`). The panel
        // keeps no client-reported metadata, hence the nulls.
        hwidUserDevice: {
          hwid: payload.hwid,
          platform: null,
          osVersion: null,
          deviceModel: null,
          // Remnawave's name for our firstSeenAt, and load-bearing: the shop
          // hashes hwid + createdAt into its dedupe fingerprint, so a device
          // removed and reconnected (same hwid, new row) reads as a new event.
          createdAt: payload.firstSeenAt.toISOString(),
        },
      },
    );
  });
}
