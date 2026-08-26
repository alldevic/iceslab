import { eventBus, type DomainEventMap } from '../../lib/event-bus.js';
import { emitWebhook } from '../../lib/webhook.js';

/**
 * K2: forward externally-meaningful domain events to the webhook bus.
 *
 * One subscriber; the events are already emitted onto the typed event bus by
 * the services, so there are no call-site changes. `inbound.*` and `binding.*`
 * are node-push plumbing (interesting to the node-agent, not to a billing bot),
 * so only the user / profile / node lifecycle is forwarded.
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
 * Subscribing twice would attach a SECOND listener to every event above, and
 * the bus calls both: one user creation becomes two webhook deliveries. A
 * receiver that counts — a billing bot, a provisioning hook — then doubles
 * every number it keeps, and nothing on this side looks wrong, because both
 * deliveries are genuine.
 *
 * Today there is exactly one call, from `index.ts`. The guard is here because
 * the plausible refactor is moving that call into `buildApp()`, which the test
 * suite invokes per case; the failure would first appear as a receiver's
 * numbers being off, long after the change.
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
  // Liveness the status field cannot show: a node still reporting healthy while
  // its traffic and its active users both collapse (censored, or silently
  // broken). See stats.anomaly.ts for why that is read as one signal.
  forward('node.anomaly');
  forward('profile.created');
  forward('profile.updated');
  forward('profile.deleted');
}
