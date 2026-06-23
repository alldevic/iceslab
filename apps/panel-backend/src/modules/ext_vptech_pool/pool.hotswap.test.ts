import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotswapController } from './pool.hotswap.js';
import {
  DEFAULT_HOTSWAP_CONFIG,
  type AnomalyEvent,
  type BurnedNode,
  type HotswapConfig,
  type HotswapDeps,
  type SpareNode,
} from './pool.types.js';

const SPARE: SpareNode = {
  id: 'spare-1',
  name: 'eu-spare',
  asn: 'AS999',
  provider: 'ovh',
  countryCode: 'DE',
  consumptionMultiplier: 1,
};

const BURNED: BurnedNode = { id: 'node-N', asn: 'AS100', provider: 'hetzner', countryCode: 'DE' };

function anomaly(over: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    nodeId: BURNED.id,
    severity: 'critical',
    bytesThisPoll: 0,
    expectedBaseline: 1_000_000,
    activeUsers: 0,
    droppedUsers: 30,
    ...over,
  };
}

describe('HotswapController (F2)', () => {
  let clock: number;
  let deps: HotswapDeps;
  let order: string[];

  beforeEach(() => {
    clock = 1_000_000;
    order = [];
    deps = {
      now: () => clock,
      promote: vi.fn(async () => void order.push('promote')),
      repoint: vi.fn(async () => void order.push('repoint')),
      retire: vi.fn(async () => void order.push('retire')),
    };
  });

  const make = (cfg: Partial<HotswapConfig> = {}) =>
    new HotswapController({ ...DEFAULT_HOTSWAP_CONFIG, enabled: true, ...cfg }, deps);

  it('does nothing when disabled (off-by-default)', async () => {
    const c = new HotswapController(DEFAULT_HOTSWAP_CONFIG, deps); // enabled:false
    const r = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(r).toEqual({ acted: false, reason: 'disabled' });
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it('ignores anomalies below the configured severity', async () => {
    const c = make({ minSeverity: 'critical' });
    const r = await c.onAnomaly(anomaly({ severity: 'warning' }), [SPARE], BURNED);
    expect(r.reason).toBe('below-severity');
    expect(r.acted).toBe(false);
  });

  it('debounces: first anomaly does not act when triggerCount=2', async () => {
    const c = make({ triggerCount: 2 });
    const r = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(r).toEqual({ acted: false, reason: 'debouncing' });
    expect(c.pendingAnomalies(BURNED.id)).toBe(1);
  });

  it('swaps once the anomaly recurs triggerCount times in the window', async () => {
    const c = make({ triggerCount: 2, windowMs: 10_000 });
    await c.onAnomaly(anomaly(), [SPARE], BURNED);
    clock += 5_000; // within window
    const r = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(r).toEqual({ acted: true, reason: 'swapped', spareId: 'spare-1' });
    // promote → repoint → retire, in that order
    expect(order).toEqual(['promote', 'repoint', 'retire']);
    expect(deps.repoint).toHaveBeenCalledWith('node-N', 'spare-1');
    expect(deps.retire).toHaveBeenCalledWith('node-N');
  });

  it('does not count anomalies that fall outside the window', async () => {
    const c = make({ triggerCount: 2, windowMs: 10_000 });
    await c.onAnomaly(anomaly(), [SPARE], BURNED);
    clock += 20_000; // first anomaly now stale
    const r = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(r.reason).toBe('debouncing'); // only 1 fresh anomaly
    expect(c.pendingAnomalies(BURNED.id)).toBe(1);
  });

  it('enforces a post-swap cooldown for the same node', async () => {
    const c = make({ triggerCount: 1, cooldownMs: 100_000 });
    const first = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(first.acted).toBe(true);
    clock += 50_000; // still within cooldown
    const second = await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(second).toEqual({ acted: false, reason: 'cooldown' });
    expect(deps.promote).toHaveBeenCalledTimes(1);
  });

  it('reports no-spare when the cold pool is empty', async () => {
    const c = make({ triggerCount: 1 });
    const r = await c.onAnomaly(anomaly(), [], BURNED);
    expect(r).toEqual({ acted: false, reason: 'no-spare' });
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it('onRecovery clears the debounce so a future outage starts fresh', async () => {
    const c = make({ triggerCount: 2, windowMs: 1_000_000 });
    await c.onAnomaly(anomaly(), [SPARE], BURNED);
    expect(c.pendingAnomalies(BURNED.id)).toBe(1);
    c.onRecovery(BURNED.id);
    expect(c.pendingAnomalies(BURNED.id)).toBe(0);
  });

  it('picks a diverse spare (avoids the burned AS) when several exist', async () => {
    const c = make({ triggerCount: 1 });
    const sameAs: SpareNode = { ...SPARE, id: 'same', asn: 'AS100' };
    const diverse: SpareNode = { ...SPARE, id: 'diverse', asn: 'AS777' };
    const r = await c.onAnomaly(anomaly(), [sameAs, diverse], BURNED);
    expect(r.spareId).toBe('diverse');
  });
});
