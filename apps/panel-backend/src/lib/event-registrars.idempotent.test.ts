import { describe, expect, it } from 'vitest';

import { eventBus, type DomainEventMap } from './event-bus.js';
import { registerUserEventHandlers } from '../modules/users/users.events.js';
import { registerNodeEventHandlers } from '../modules/nodes/nodes.events.js';
import { registerInboundEventHandlers } from '../modules/inbounds/inbounds.events.js';
import { registerWebhookEventHandlers } from '../modules/webhooks/webhook.events.js';
import { registerPoolEventHandlers } from '../modules/ext_vptech_pool/pool.service.js';
import { config } from '../config.js';

/**
 * Five registrars subscribe this process to the bus. One of them was written
 * not to do it twice.
 *
 * `registerWebhookEventHandlers` got its `if (registered) return` after someone
 * noticed what a second call would mean for a receiver that counts. The other
 * four are the same function shape with the same lifetime — the bus has `on`
 * and no `off`, so a second call adds a second handler that fires forever — and
 * none of them had the guard. That is the shape this repository keeps finding:
 * a decision applied to one of the places it is about.
 *
 * Nothing calls any of them twice today. `registerUserEventHandlers` is already
 * called from two test files besides index.ts, and moving the bootstrap call
 * into `buildApp()` is a plausible refactor — the binding-cache reset is
 * already wired that way. The failure would arrive as duplicate jobs, duplicate
 * audit rows and duplicate webhook deliveries, all of them individually
 * genuine, with nothing on this side looking wrong.
 *
 * The observable is the listener count, because the alternative is emitting the
 * events and watching what these handlers do, which is write rows and enqueue
 * jobs.
 */

/** Every event a registrar under test subscribes to. */
const WATCHED: (keyof DomainEventMap)[] = [
  'user.created',
  'user.updated',
  'user.status-changed',
  'user.deleted',
  'user.traffic-reset',
  'node.created',
  'node.updated',
  'node.changed',
  'node.deleted',
  'node.status-changed',
  'node.anomaly',
  'host.changed',
  'squad.changed',
  'profile.created',
  'profile.updated',
  'profile.deleted',
  'binding.created',
  'binding.updated',
  'binding.deleted',
  'cascade.changed',
];

const snapshot = (): Record<string, number> =>
  Object.fromEntries(WATCHED.map((e) => [e, eventBus.listenerCount(e)]));

const grew = (before: Record<string, number>, after: Record<string, number>): string[] =>
  WATCHED.filter((e) => after[e]! > before[e]!).map((e) => `${e}: ${before[e]} → ${after[e]}`);

describe('the bus is subscribed once per process', () => {
  // Order matters here and the cases are deliberately not independent: each
  // registrar is called for the FIRST time inside its own case, so "the first
  // call subscribed something" is a real observation rather than a leftover.
  const cases: [string, () => void][] = [
    ['registerUserEventHandlers', registerUserEventHandlers],
    ['registerNodeEventHandlers', registerNodeEventHandlers],
    ['registerInboundEventHandlers', registerInboundEventHandlers],
    ['registerWebhookEventHandlers', registerWebhookEventHandlers],
  ];

  it.each(cases)('%s subscribes on the first call', (name, fn) => {
    const before = snapshot();
    fn();
    const after = snapshot();
    // The control. Without it, "the second call added nothing" is also true of
    // a registrar that adds nothing at all — which is how a broken extraction
    // passes.
    expect(
      grew(before, after),
      `${name} subscribed to nothing, so the idempotency case below proves nothing`,
    ).not.toHaveLength(0);
  });

  it.each(cases)('%s adds nothing on the second call', (name, fn) => {
    const before = snapshot();
    fn();
    fn();
    const after = snapshot();
    expect(
      grew(before, after),
      `${name} subscribed again; the bus has no off, so both copies fire forever`,
    ).toEqual([]);
  });

  // The pool registrar is off behind a feature flag, so on a panel that has not
  // enabled it there is nothing to observe. Say which of the two ran rather
  // than passing on an empty comparison.
  const poolOn = config.EXT_VPTECH_POOL_ENABLED;
  it(
    poolOn
      ? 'registerPoolEventHandlers subscribes once and only once'
      : 'registerPoolEventHandlers subscribes to nothing while EXT_VPTECH_POOL_ENABLED is off',
    () => {
      const before = eventBus.listenerCount('node.anomaly');
      registerPoolEventHandlers();
      const once = eventBus.listenerCount('node.anomaly');
      registerPoolEventHandlers();
      const twice = eventBus.listenerCount('node.anomaly');

      if (poolOn) {
        expect(once, 'the enabled pool registrar subscribed to nothing').toBe(before + 1);
      } else {
        expect(once, 'a disabled feature subscribed anyway').toBe(before);
      }
      // The half that holds either way, and the one that matters: two ansible
      // runs racing to repoint one burned node onto two different spares.
      expect(twice, 'a second call added a second hotswap controller').toBe(once);
    },
  );

  it('counts listeners at all, so the comparisons above are not between zeroes', () => {
    // The parser control for a test whose whole instrument is one number.
    const probe = (): void => {};
    const before = eventBus.listenerCount('squad.changed');
    eventBus.on('squad.changed', probe);
    expect(eventBus.listenerCount('squad.changed')).toBe(before + 1);
  });
});
