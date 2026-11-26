// Which domain events leave the panel, and which stay inside it.
//
// Nothing observed the registry: deleting `forward('node.status-changed')` kept
// the whole suite green, and that is the one event an operator's bot waits for
// to learn its fleet went down. A missing forward fails silently (the panel is
// fine, the events just never arrive); an extra one turns a billing
// integration into a firehose, because `binding.*` fires on every config push.
//
// Every event on the bus is classified below, either FORWARDED or INTERNAL. An
// event the bus gains without a decision here fails the classification case.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the mock factory is lifted above every import, so a plain const
// would still be in its temporal dead zone when the factory runs.
const { emitted } = vi.hoisted(() => ({ emitted: [] as string[] }));
vi.mock('../../lib/notify/webhook.js', () => ({
  emitWebhook: (event: string) => {
    emitted.push(event);
  },
}));

const { eventBus } = await import('../../lib/infra/event-bus.js');
const { registerWebhookEventHandlers } = await import('./webhook.events.js');

/**
 * Every event the panel knows about, read out of the event bus source rather
 * than listed here: a list in this file would go stale the moment somebody adds
 * an event, and the point is that a NEW event has to be classified.
 */
function allDomainEvents(): string[] {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/infra/event-bus.ts'),
    'utf8',
  );
  const start = src.indexOf('export interface DomainEventMap {');
  const body = src.slice(start, src.indexOf('\n}', start));
  const names = [...body.matchAll(/^\s*'([a-z][a-zA-Z.-]*)':/gm)].map((m) => m[1]!);
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
  'profile.created',
  'profile.updated',
  'profile.deleted',
];

/** Cache invalidation and node config re-push: plumbing, not for receivers. */
const INTERNAL = [
  'node.updated',
  'node.changed',
  'host.changed',
  'policy.changed',
  'squad.changed',
  'binding.created',
  'binding.updated',
  'binding.deleted',
  'cascade.changed',
  'geo.rolledOut',
];

/**
 * The bus hands each payload to its handler inside `Promise.resolve().then`,
 * so delivery lands on a microtask; one turn of the loop is enough.
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

    expect(events.filter((e) => emitted.includes(e)).sort()).toEqual([...FORWARDED].sort());

    expect(
      emitted,
      'a bot learns its fleet is down from node.status-changed; without it a receiver has to poll',
    ).toContain('node.status-changed');
    expect(
      emitted,
      'user.status-changed is how a receiver hears about an expiry or a hit limit',
    ).toContain('user.status-changed');
    expect(emitted, 'user.traffic-reset is the counter reset a billing bot waits for').toContain(
      'user.traffic-reset',
    );

    for (const plumbing of INTERNAL) {
      expect(emitted, `${plumbing} is internal plumbing, not a webhook`).not.toContain(plumbing);
    }
  });

  // FORWARDED / INTERNAL are this file's opinion; the source of truth is the
  // bus. An event on one side that the bus lacks, or on the bus and on neither
  // side, shows up here by name instead of as silence.
  it('classifies every event the bus knows about, and only those', () => {
    const events = allDomainEvents();
    const classified = [...FORWARDED, ...INTERNAL];

    expect(events.filter((e) => !classified.includes(e)), 'events with no decision').toEqual([]);
    expect(classified.filter((e) => !events.includes(e)), 'classified but not on the bus').toEqual(
      [],
    );
    expect(FORWARDED.filter((e) => INTERNAL.includes(e))).toEqual([]);
  });

  // The bus has `on` and no `off`: a second subscription is a second delivery
  // of every webhook, forever, with no symptom. Asked of the bus directly.
  it('subscribes exactly one forwarder per forwarded event, even when called twice', () => {
    registerWebhookEventHandlers();
    registerWebhookEventHandlers();

    for (const name of FORWARDED) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((eventBus as any).listenerCount(name), name).toBe(1);
    }
    for (const name of INTERNAL) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((eventBus as any).listenerCount(name), name).toBe(0);
    }
  });
});
