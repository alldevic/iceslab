// Which domain events leave the panel, and which stay inside it.
//
// Measured before writing: the whole suite stayed green with
// `forward('node.status-changed')` deleted from the registry - the one event an
// operator's bot waits for to learn its own fleet went down. Nothing observed
// the registry at all.
//
// Both directions cost something. A missing forward is a bot that never hears
// about an outage or an expiry, and it fails silently: the panel is fine, the
// events simply do not arrive. An extra forward is worse in a different way -
// `inbound.*` and `binding.*` fire on every config push, several per node, so
// forwarding them turns a billing integration into a firehose.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the mock factory is lifted above every import, so an array
// declared with a plain const would still be in its temporal dead zone when the
// factory runs - and the capture would silently record nothing.
const { emitted } = vi.hoisted(() => ({ emitted: [] as string[] }));
vi.mock('../../lib/webhook.js', () => ({
  emitWebhook: (event: string) => {
    emitted.push(event);
  },
}));

const { eventBus } = await import('../../lib/event-bus.js');
const { registerWebhookEventHandlers } = await import('./webhook.events.js');

/**
 * Every event the panel knows about, read out of the event bus itself rather
 * than listed here. A list written in this file would go stale the moment
 * somebody adds an event, and the whole point is that a NEW event has to be
 * classified - externally meaningful, or internal plumbing - instead of
 * defaulting to whichever side nobody notices.
 */
function allDomainEvents(): string[] {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/event-bus.ts'),
    'utf8',
  );
  const body = src.slice(
    src.indexOf('export interface DomainEventMap {'),
    src.indexOf('\n}', src.indexOf('export interface DomainEventMap {')),
  );
  const names = [...body.matchAll(/^\s*'([a-z][a-z.-]*)':/gm)].map((m) => m[1]!);
  return [...new Set(names)];
}

/** The lifecycle a receiver outside the panel is entitled to hear about. */
const FORWARDED = [
  'user.created',
  'user.updated',
  'user.status-changed',
  'user.deleted',
  'user.traffic-reset',
  'node.created',
  'node.status-changed',
  'node.deleted',
  'node.anomaly',
  'profile.created',
  'profile.updated',
  'profile.deleted',
];

/**
 * The bus hands each payload to its handler inside a `Promise.resolve().then`,
 * so delivery lands on a microtask and an assertion written straight after the
 * emit is racing it. One turn of the event loop is enough, and asking for it
 * explicitly is what keeps this file from passing by accident of timing.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  emitted.length = 0;
});

describe('the webhook registry', () => {
  it('forwards the lifecycle a receiver waits for, and nothing else', async () => {
    registerWebhookEventHandlers();

    const events = allDomainEvents();
    expect(events.length, 'the event map was not parsed').toBeGreaterThan(15);

    for (const name of events) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventBus as any).emit(name, {});
    }
    await settle();

    const gotForwarded = events.filter((e) => emitted.includes(e)).sort();
    const expectedForwarded = FORWARDED.filter((e) => events.includes(e)).sort();
    expect(gotForwarded).toEqual(expectedForwarded);

    // Named individually so a failure says WHICH one, and why it matters.
    expect(
      emitted,
      'a bot learns its own fleet is down from node.status-changed; before it existed, ' +
        'node liveness only reached a Telegram chat and a receiver had to poll',
    ).toContain('node.status-changed');
    expect(
      emitted,
      'node.anomaly is liveness the status field cannot show: a node still reporting ' +
        'healthy while its traffic and its users both collapse',
    ).toContain('node.anomaly');
    expect(
      emitted,
      'user.status-changed is how a receiver hears about an expiry or a hit limit',
    ).toContain('user.status-changed');

    // inbound.* was here until 2026-08-27, when it was removed from the bus
    // entirely: nothing emitted it. binding.* is the live equivalent.
    for (const plumbing of ['binding.created', 'binding.updated', 'binding.deleted']) {
      expect(
        emitted,
        `${plumbing} fires on every config push, several per node: it is node-agent ` +
          'plumbing, and a billing receiver drowns in it',
      ).not.toContain(plumbing);
    }
  });

  // FORWARDED above is this test's own opinion; the source is the registry.
  // Anything the map gains and the registry ignores shows up here as an
  // unclassified name rather than as silence.
  it('classifies every event the panel knows about', () => {
    const events = allDomainEvents();
    const unclassified = events.filter(
      (e) => !FORWARDED.includes(e) && !e.startsWith('inbound.') && !e.startsWith('binding.'),
    );
    // Everything left is internal: cache invalidation and config re-push.
    // Listed so a new arrival is a visible decision instead of a default.
    expect(unclassified.sort()).toEqual(
      [
        'cascade.changed',
        'host.changed',
        'node.changed',
        'node.updated',
        'squad.changed',
      ].sort(),
    );
  });

  // Registering twice attaches a second listener to every event, and the bus
  // calls both: one user creation leaves the panel as two identical webhook
  // deliveries. A receiver that counts anything doubles it, and nothing looks
  // wrong from here — both deliveries are genuine.
  //
  // There is one call site today (index.ts), so this pins a guard rather than
  // a bug. It is worth pinning because the plausible refactor is moving that
  // call into `buildApp()`, which the suite invokes once per case: the panel
  // would still work, and the first symptom would be somebody's numbers being
  // off, weeks later.
  it('stays at one listener per event however often it is called', async () => {
    registerWebhookEventHandlers();
    registerWebhookEventHandlers();
    registerWebhookEventHandlers();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (eventBus as any).emit('user.created', {});
    await settle();

    expect(
      emitted.filter((e) => e === 'user.created'),
      'one event left the panel more than once',
    ).toEqual(['user.created']);
  });
});
