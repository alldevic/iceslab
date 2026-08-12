import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { emitRemnaWebhook, isRemnaWebhookConfigured } from './remnawave.webhook.js';

/**
 * Hook A — emit `user.expired` when the lifecycle cron flips a user active →
 * expired. Piggybacks the existing `user.status-changed` event (no call-site
 * change). Filter on `to === 'expired'` (the `to === 'limited'` transition from
 * findExceededTrafficUsers must be excluded). No dedup needed: findExpiredUsers
 * selects status:'active' and flips before emitting, so a cycle fires once.
 *
 * The `user.expires_in_{72,48,24}_hours` events come from the separate cron scan
 * (scanRemnaExpiryNotifications) — there is no native "upcoming expiry" event.
 */
export function registerRemnawaveWebhookEmitter(): void {
  eventBus.on('user.status-changed', async (payload) => {
    if (payload.to !== 'expired') return;
    if (!isRemnaWebhookConfigured()) return;
    const row = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, telegramId: true, email: true, expireAt: true },
    });
    if (!row) return; // raced a hard delete
    emitRemnaWebhook('user.expired', row, {});
  });
}
