import { describe, expect, it } from 'vitest';

import { eventBus, type DomainEventMap } from './event-bus.js';
import { registerUserEventHandlers } from '../../modules/users/users.events.js';
import { registerNodeEventHandlers } from '../../modules/nodes/nodes.events.js';
import { registerInboundEventHandlers } from '../../modules/inbounds/inbounds.events.js';
import { registerWebhookEventHandlers } from '../../modules/webhooks/webhook.events.js';
import { registerCascadeEventHandlers } from '../../modules/cascades/cascade.events.js';
import { registerBindingsCacheBust } from '../../modules/subscription/subscription.bindings-cache.js';

/**
 * The bus has `on` and no `off`, so a second call of a registrar adds a second
 * handler that fires forever (two addUser jobs, two audit rows, two webhook
 * deliveries). The observable is the listener count.
 */

/** Every event the registrars under test subscribe to. */
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
  'host.changed',
  'squad.changed',
  'policy.changed',
  'geo.rolledOut',
  'profile.created',
  'profile.updated',
  'profile.deleted',
  'binding.created',
  'binding.updated',
  'binding.deleted',
  'cascade.changed',
  'cascade.exits-changed',
];

const snapshot = (): Record<string, number> =>
  Object.fromEntries(WATCHED.map((e) => [e, eventBus.listenerCount(e)]));

const grew = (before: Record<string, number>, after: Record<string, number>): string[] =>
  WATCHED.filter((e) => after[e]! > before[e]!).map((e) => `${e}: ${before[e]} → ${after[e]}`);

describe('the bus is subscribed once per process', () => {
  // The cases are not independent: each registrar is called for the FIRST time
  // inside its own case, so "the first call subscribed something" is real.
  const cases: [string, () => void][] = [
    ['registerUserEventHandlers', registerUserEventHandlers],
    ['registerNodeEventHandlers', registerNodeEventHandlers],
    ['registerInboundEventHandlers', registerInboundEventHandlers],
    ['registerWebhookEventHandlers', registerWebhookEventHandlers],
    ['registerCascadeEventHandlers', registerCascadeEventHandlers],
    ['registerBindingsCacheBust', registerBindingsCacheBust],
  ];

  it.each(cases)('%s subscribes on the first call', (name, fn) => {
    const before = snapshot();
    fn();
    // The control: without it "the second call added nothing" is also true of
    // a registrar that adds nothing at all.
    expect(grew(before, snapshot()), `${name} subscribed to nothing`).not.toHaveLength(0);
  });

  it.each(cases)('%s adds nothing on the second call', (name, fn) => {
    const before = snapshot();
    fn();
    fn();
    expect(grew(before, snapshot()), `${name} subscribed again`).toEqual([]);
  });

  it('counts listeners at all, so the comparisons above are not between zeroes', () => {
    const before = eventBus.listenerCount('squad.changed');
    eventBus.on('squad.changed', () => {});
    expect(eventBus.listenerCount('squad.changed')).toBe(before + 1);
  });
});
