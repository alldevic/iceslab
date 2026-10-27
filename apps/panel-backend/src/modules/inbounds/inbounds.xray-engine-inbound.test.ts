import { describe, it, expect } from 'vitest';
import { xrayEngineInbound } from './inbounds.queue.js';

/**
 * Per-node routing (cascade, WARP) rides the one xray config.json, so it goes
 * on an inbound the xray ENGINE serves. An xray-protocol inbound on sing-box
 * cannot carry it: the agent refused the cascade (the whole push with it) and
 * dropped WARP silently, the node showing WARP on.
 */
describe('xrayEngineInbound', () => {
  it('skips an xray inbound on sing-box and takes the next one on xray', () => {
    const got = xrayEngineInbound([
      { id: 'sb', protocol: 'xray', engine: 'singbox' as const },
      { id: 'hy', protocol: 'hysteria' },
      { id: 'xr', protocol: 'xray' },
    ]);
    expect(got?.id).toBe('xr');
  });

  it('an explicit xray engine counts; none at all is none', () => {
    expect(xrayEngineInbound([{ id: 'x', protocol: 'xray', engine: 'xray' as const }])?.id).toBe('x');
    expect(xrayEngineInbound([{ id: 'sb', protocol: 'xray', engine: 'singbox' as const }])).toBeUndefined();
  });
});
