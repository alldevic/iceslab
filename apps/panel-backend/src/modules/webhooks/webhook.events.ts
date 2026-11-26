import { eventBus, type DomainEventMap } from '../../lib/infra/event-bus.js';
import { emitWebhook } from '../../lib/notify/webhook.js';

/**
 * K2: forward externally-meaningful domain events to the webhook bus.
 *
 * One subscriber; the events are already emitted onto the typed event bus by
 * the services, so there are no call-site changes. `binding.*` is
 * node-push plumbing (interesting to the node-agent, not to a billing bot), so
 * only the user / profile / node lifecycle and the cascade exits state are forwarded.
 *
 * The four an operator's bot actually waits for are now all here: a node going
 * down or coming back (`node.status-changed`), a user expiring or hitting their
 * limit (`user.status-changed`, moved by the cron), and a counter reset
 * (`user.traffic-reset`). Before this, node liveness only reached a Telegram
 * chat, so a bot had to poll the panel to learn its own fleet was down.
 */
function forward<K extends keyof DomainEventMap>(event: K): void {
  eventBus.on(event, (payload) => emitWebhook(event, payload));
}

/**
 * One subscription per process. The bus has `on` and no `off`, so a second call
 * adds a SECOND handler for every event here and both keep firing forever.
 * Today there is one call, from `index.ts`; the guard is for the day that call
 * moves somewhere that runs per case (buildApp() in tests).
 */
let registered = false;

export function registerWebhookEventHandlers(): void {
  if (registered) return;
  registered = true;
  forward('user.created');
  forward('user.updated');
  forward('user.status-changed');
  forward('user.deleted');
  forward('user.traffic-reset');
  forward('node.created');
  // Liveness. Carries from/to, so a receiver can tell "went down" from "came
  // back" without keeping state of its own.
  forward('node.status-changed');
  forward('node.deleted');
  // A cascade losing its last live exit, or getting one back. Its entry refuses
  // connections in that state, so without this a receiver hears it from the
  // subscribers.
  forward('cascade.exits-changed');
  forward('profile.created');
  forward('profile.updated');
  forward('profile.deleted');
}
