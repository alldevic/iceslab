import { describe, expect, it, beforeAll } from 'vitest';

/**
 * The pool registrar, with its feature flag ON.
 *
 * `event-registrars.idempotent.test.ts` covers the other four and says out loud
 * that it cannot cover this one: `registerPoolEventHandlers` returns before its
 * guard while EXT_VPTECH_POOL_ENABLED is off, so on a default test environment
 * "the second call added nothing" is true of a function that does nothing at
 * all. Removing the guard leaves that suite green — measured, by removing it.
 *
 * So the flag is set here, before anything imports config, and this file is the
 * only place in the suite where the enabled path runs. Vitest isolates modules
 * per file, so the flag does not leak to the rest.
 *
 * What a second subscription would mean is worth stating: every `node.anomaly`
 * would reach two HotswapControllers, each with its own debounce state, and
 * both would pick a spare for the same burned node — two ansible runs racing to
 * repoint one node onto two different machines.
 */
process.env.EXT_VPTECH_POOL_ENABLED = 'true';

let eventBus: typeof import('../../lib/event-bus.js').eventBus;
let registerPoolEventHandlers: typeof import('./pool.service.js').registerPoolEventHandlers;
let enabled = false;

beforeAll(async () => {
  ({ eventBus } = await import('../../lib/event-bus.js'));
  ({ registerPoolEventHandlers } = await import('./pool.service.js'));
  const { config } = await import('../../config.js');
  enabled = config.EXT_VPTECH_POOL_ENABLED;
});

describe('registerPoolEventHandlers with the pool enabled', () => {
  it('the flag really is on in this file, or the case below is the disabled one again', () => {
    expect(enabled, 'setting the env before the import did not reach config').toBe(true);
  });

  it('subscribes exactly one hotswap handler, however many times it is called', () => {
    const before = eventBus.listenerCount('node.anomaly');

    registerPoolEventHandlers();
    const once = eventBus.listenerCount('node.anomaly');
    expect(once, 'the enabled registrar subscribed to nothing').toBe(before + 1);

    registerPoolEventHandlers();
    registerPoolEventHandlers();
    expect(
      eventBus.listenerCount('node.anomaly'),
      'a second controller is subscribed; two ansible runs would race for one burned node',
    ).toBe(once);
  });
});
