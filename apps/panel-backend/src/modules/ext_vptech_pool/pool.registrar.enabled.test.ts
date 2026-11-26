import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The registrar with its flag ON, set before anything imports config (vitest
 * isolates modules per file, so it does not leak). A second subscription would
 * put two controllers on every incident, each picking a spare for the same
 * burned node: two installs racing for one replacement.
 */
process.env.EXT_VPTECH_POOL_ENABLED = 'true';

let registerPoolEventHandlers: typeof import('./pool.service.js').registerPoolEventHandlers;
let eventBus: typeof import('../../lib/infra/event-bus.js').eventBus;
let enabled = false;

beforeAll(async () => {
  ({ registerPoolEventHandlers } = await import('./pool.service.js'));
  ({ eventBus } = await import('../../lib/infra/event-bus.js'));
  enabled = (await import('../../config.js')).config.EXT_VPTECH_POOL_ENABLED;
});

describe('registerPoolEventHandlers with the pool enabled', () => {
  it('the flag really is on in this file', () => {
    expect(enabled).toBe(true);
  });

  it('subscribes once to both events, however many times it is called', () => {
    const anomaly = eventBus.listenerCount('node.anomaly');
    const cleared = eventBus.listenerCount('node.anomaly-cleared');
    expect(registerPoolEventHandlers()).toBe(true);
    expect(registerPoolEventHandlers()).toBe(false);
    expect(registerPoolEventHandlers()).toBe(false);
    expect(eventBus.listenerCount('node.anomaly')).toBe(anomaly + 1);
    expect(eventBus.listenerCount('node.anomaly-cleared')).toBe(cleared + 1);
  });
});
