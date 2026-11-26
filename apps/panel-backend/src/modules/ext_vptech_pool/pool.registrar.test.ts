import { describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { registerPoolEventHandlers } from './pool.service.js';

// The default: the flag is off, so the pool puts no subscriber on the sensor's
// events and the panel behaves as without it.
describe('registerPoolEventHandlers with the pool off (the default)', () => {
  it('the flag is off', () => {
    expect(config.EXT_VPTECH_POOL_ENABLED).toBe(false);
  });

  it('subscribes to nothing, and a later call is still free to', () => {
    const anomaly = eventBus.listenerCount('node.anomaly');
    const cleared = eventBus.listenerCount('node.anomaly-cleared');
    expect(registerPoolEventHandlers()).toBe(false);
    expect(registerPoolEventHandlers()).toBe(false);
    expect(eventBus.listenerCount('node.anomaly')).toBe(anomaly);
    expect(eventBus.listenerCount('node.anomaly-cleared')).toBe(cleared);
  });
});
