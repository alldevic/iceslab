import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotswapController } from './pool.hotswap.js';
import {
  DEFAULT_HOTSWAP_CONFIG,
  type AnomalyEvent,
  type BurnedNode,
  type HotswapConfig,
  type HotswapDeps,
  type SpareNode,
  type SwapNotice,
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

describe('HotswapController', () => {
  let clock: number;
  let order: string[];
  let scheduled: { fn: () => void; ms: number }[];
  let notices: SwapNotice[];
  let spares: SpareNode[];
  let deps: HotswapDeps;

  beforeEach(() => {
    clock = 1_000_000;
    order = [];
    scheduled = [];
    notices = [];
    spares = [SPARE];
    deps = {
      now: () => clock,
      schedule: (fn, ms) => void scheduled.push({ fn, ms }),
      notify: (n) => void notices.push(n),
      loadPool: async () => ({ spares, burned: BURNED }),
      promote: vi.fn(async () => void order.push('promote')),
      repoint: vi.fn(async () => {
        order.push('repoint');
        return { carried: 2, total: 2, notes: [] };
      }),
      retire: vi.fn(async () => void order.push('retire')),
    };
  });

  const make = (cfg: Partial<HotswapConfig> = {}) =>
    new HotswapController({ ...DEFAULT_HOTSWAP_CONFIG, enabled: true, ...cfg }, deps);

  /** Run the confirmation the controller scheduled, as the timer would. */
  async function fireScheduled(c: HotswapController) {
    const job = scheduled.shift();
    expect(job, 'nothing was scheduled').toBeDefined();
    clock += job!.ms;
    job!.fn();
    // confirm() is queued behind earlier swaps; let it run.
    await vi.waitFor(() => expect(c.pending(BURNED.id)).toBe(false));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('does nothing when disabled (off by default)', () => {
    const c = new HotswapController(DEFAULT_HOTSWAP_CONFIG, deps);
    expect(c.onAnomaly(anomaly())).toBe('disabled');
    expect(scheduled).toHaveLength(0);
  });

  it('ignores a warning when the bar is critical', () => {
    expect(make().onAnomaly(anomaly({ severity: 'warning' }))).toBe('below-severity');
    expect(scheduled).toHaveLength(0);
  });

  it('swaps a node whose incident is still open after confirmMs: promote → repoint → retire', async () => {
    const c = make();
    expect(c.onAnomaly(anomaly())).toBe('pending');
    expect(scheduled[0]!.ms).toBe(DEFAULT_HOTSWAP_CONFIG.confirmMs);
    await fireScheduled(c);
    expect(order).toEqual(['promote', 'repoint', 'retire']);
    expect(deps.promote).toHaveBeenCalledWith(SPARE, BURNED.id);
    expect(notices).toEqual([
      { kind: 'swapped', burnedId: BURNED.id, spareId: SPARE.id, report: { carried: 2, total: 2, notes: [] } },
    ]);
  });

  // The sensor raises node.anomaly once per incident. A node blocked for good
  // raises exactly one; a confirmation that waited for a second event would
  // never swap the node that needs it most.
  it('confirms on one event, by duration', async () => {
    const c = make();
    c.onAnomaly(anomaly());
    await fireScheduled(c);
    expect(deps.promote).toHaveBeenCalledTimes(1);
  });

  it('a cleared incident is not swapped', async () => {
    const c = make();
    c.onAnomaly(anomaly());
    c.onCleared(BURNED.id);
    scheduled[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
  });

  it('a cleared and reopened incident waits for its own confirmation', async () => {
    const c = make();
    c.onAnomaly(anomaly());
    clock += 60_000;
    c.onCleared(BURNED.id);
    clock += 60_000;
    c.onAnomaly(anomaly());
    expect(scheduled).toHaveLength(2);
    // The first timer belongs to the incident that cleared.
    expect(await c.confirm(BURNED.id, 1_000_000)).toEqual({ acted: false, reason: 'cleared' });
    expect(order).toEqual([]);
  });

  it('a repeated event inside an open incident schedules nothing new', () => {
    const c = make();
    c.onAnomaly(anomaly());
    c.onAnomaly(anomaly());
    expect(scheduled).toHaveLength(1);
  });

  it('respects the post-swap cooldown', async () => {
    const c = make();
    c.onAnomaly(anomaly());
    await fireScheduled(c);
    clock += 10 * 60 * 1000;
    expect(c.onAnomaly(anomaly())).toBe('cooldown');
    clock += DEFAULT_HOTSWAP_CONFIG.cooldownMs;
    expect(c.onAnomaly(anomaly())).toBe('pending');
  });

  it('tells the operator when the pool is empty', async () => {
    spares = [];
    const c = make();
    c.onAnomaly(anomaly());
    await fireScheduled(c);
    expect(order).toEqual([]);
    expect(notices).toEqual([{ kind: 'no-spare', burnedId: BURNED.id }]);
  });

  it('a failed promote is reported with its stage, and nothing after it runs', async () => {
    deps.promote = vi.fn(async () => {
      throw new Error('ansible exited 2');
    });
    const c = make();
    c.onAnomaly(anomaly());
    await fireScheduled(c);
    expect(order).toEqual([]);
    expect(notices).toEqual([
      { kind: 'failed', burnedId: BURNED.id, spareId: SPARE.id, stage: 'promote', error: 'ansible exited 2' },
    ]);
  });

  // Two nodes burned in the same minute must not both take the one spare: the
  // second swap reads the pool after the first has promoted from it.
  it('runs swaps one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    deps.promote = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    const c = make();
    c.onAnomaly(anomaly({ nodeId: 'a' }));
    c.onAnomaly(anomaly({ nodeId: 'b' }));
    const [ja, jb] = scheduled;
    await Promise.all([c.confirm('a', 1_000_000), c.confirm('b', 1_000_000)]);
    expect(ja && jb).toBeTruthy();
    expect(deps.promote).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});
