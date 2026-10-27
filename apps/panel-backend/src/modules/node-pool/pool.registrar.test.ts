import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The registrar with its flag ON, set before anything imports config (vitest
 * isolates modules per file, so it does not leak). A second subscription would
 * put two controllers on every incident, each picking a spare for the same
 * burned node: two installs racing for one replacement.
 */
process.env.NODE_POOL_HOTSWAP_ENABLED = 'true';

let registerNodePoolHandlers: typeof import('./pool.service.js').registerNodePoolHandlers;
let enabled = false;

beforeAll(async () => {
  ({ registerNodePoolHandlers } = await import('./pool.service.js'));
  enabled = (await import('../../config.js')).config.NODE_POOL_HOTSWAP_ENABLED;
});

describe('registerNodePoolHandlers with the pool enabled', () => {
  it('the flag really is on in this file', () => {
    expect(enabled).toBe(true);
  });

  it('subscribes once, however many times it is called', () => {
    expect(registerNodePoolHandlers()).toBe(true);
    expect(registerNodePoolHandlers()).toBe(false);
    expect(registerNodePoolHandlers()).toBe(false);
  });
});
