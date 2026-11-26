import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  loadBurnedNode,
  loadColdPool,
  makeHotswapDeps,
  type AnsibleRunner,
  type ProvisionVars,
} from './pool.service.js';
import { HotswapController } from './pool.hotswap.js';
import { DEFAULT_HOTSWAP_CONFIG, type SwapNotice } from './pool.types.js';

let seq = 0;
async function makeNode(opts: {
  name: string;
  status: string;
  pool?: Record<string, unknown>;
  consumed?: boolean;
  countryCode?: string;
  intendedEngines?: string[];
  tenths?: number;
  extra?: Record<string, unknown>;
}) {
  seq += 1;
  const node = await prisma.node.create({
    data: {
      name: `${opts.name}-${seq}`,
      address: `${opts.name}-${seq}.test`,
      status: opts.status,
      countryCode: opts.countryCode ?? null,
      heartbeatSecret: Buffer.alloc(32),
      intendedEngines: opts.intendedEngines ?? ['xray'],
      ...(opts.tenths !== undefined ? { consumptionMultiplierTenths: opts.tenths } : {}),
      ...(opts.pool ? { hardening: { pool: opts.pool } } : {}),
      ...(opts.extra ?? {}),
    },
  });
  if (opts.consumed) {
    await prisma.nodeBootstrapToken.create({
      data: { nodeId: node.id, token: `tok-${node.id}`, expiresAt: new Date(Date.now() + 1_000_000), consumedAt: new Date() },
    });
  }
  return node;
}

function runnerMock() {
  const calls: { spare: { id: string; name: string }; vars: ProvisionVars }[] = [];
  const runner: AnsibleRunner = {
    provision: vi.fn(async (spare, vars) => {
      calls.push({ spare, vars });
    }),
  };
  return { runner, calls };
}

const anomaly = (nodeId: string) => ({
  nodeId,
  severity: 'critical' as const,
  bytesThisPoll: 0,
  expectedBaseline: 1,
  activeUsers: 0,
  droppedUsers: 30,
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the cold pool', () => {
  it('is the disabled nodes marked as spares and not burned, with their labels and the multiplier in units', async () => {
    const spare = await makeNode({
      name: 'cold',
      status: 'disabled',
      pool: { spare: true, asn: 'AS200', provider: 'ovh' },
      countryCode: 'DE',
      tenths: 15,
    });
    await makeNode({ name: 'online', status: 'online', pool: { spare: true } });
    await makeNode({ name: 'burned', status: 'disabled', pool: { spare: true, burned: true } });
    await makeNode({ name: 'deleted', status: 'disabled', pool: { spare: true }, extra: { deletedAt: new Date() } });

    const pool = await loadColdPool();
    expect(pool.map((s) => s.id)).toEqual([spare.id]);
    expect(pool[0]).toMatchObject({ asn: 'AS200', provider: 'ovh', countryCode: 'DE', consumptionMultiplier: 1.5 });
  });

  it('a disabled node without the spare mark is not in it, whether or not it ever had a token', async () => {
    await makeNode({ name: 'maintenance', status: 'disabled' }); // no token at all: a purged one looks the same
    await makeNode({ name: 'maintenance-tok', status: 'disabled', consumed: true });
    await makeNode({ name: 'labelled', status: 'disabled', pool: { asn: 'AS1', provider: 'x' } });
    await makeNode({ name: 'spare-false', status: 'disabled', pool: { spare: false } });
    expect(await loadColdPool()).toEqual([]);
  });

  it('a deleted node is no burned node', async () => {
    const n = await makeNode({ name: 'gone', status: 'online', extra: { deletedAt: new Date() } });
    expect(await loadBurnedNode(n.id)).toBeNull();
  });
});

describe('a swap, against the database', () => {
  async function swap(burnedId: string, runner: AnsibleRunner) {
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner, notify: (n) => notices.push(n), schedule: (fn) => void (scheduled = fn) }),
    );
    expect(c.onAnomaly(anomaly(burnedId))).toBe('pending');
    expect(scheduled).toBeDefined();
    scheduled!(); // the timer firing; confirm() is queued, so wait for it
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
    return notices;
  }

  it('promotes the spare on another AS with a token and without its mark, retires the burned node, leaves the same-AS spare', async () => {
    const burned = await makeNode({ name: 'burned', status: 'online', pool: { asn: 'AS100' }, countryCode: 'RU' });
    const sameAs = await makeNode({ name: 'spare-same-as', status: 'disabled', pool: { spare: true, asn: 'AS100' } });
    const diverse = await makeNode({
      name: 'spare-diverse',
      status: 'disabled',
      pool: { spare: true, asn: 'AS999', provider: 'ovh' },
      countryCode: 'RU',
      intendedEngines: ['singbox'],
    });
    const emit = vi.spyOn(eventBus, 'emit');

    const { runner, calls } = runnerMock();
    const notices = await swap(burned.id, runner);
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'swapped', burnedId: burned.id, spareId: diverse.id }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.spare.id).toBe(diverse.id);
    expect(calls[0]!.vars.iceslab_engines).toEqual(['singbox']);
    const tok = await prisma.nodeBootstrapToken.findFirst({ where: { nodeId: diverse.id } });
    expect(tok?.token).toBe(calls[0]!.vars.iceslab_bootstrap_token);

    const spareAfter = await prisma.node.findUniqueOrThrow({ where: { id: diverse.id } });
    expect(spareAfter.status).toBe('unknown');
    // The mark comes off so a later maintenance stop does not put it back in the pool.
    expect(spareAfter.hardening).toEqual({ pool: { asn: 'AS999', provider: 'ovh' } });
    expect(await loadColdPool().then((p) => p.map((s) => s.id))).toEqual([sameAs.id]);

    const burnedAfter = await prisma.node.findUniqueOrThrow({ where: { id: burned.id } });
    expect(burnedAfter.status).toBe('disabled');
    expect(burnedAfter.hardening).toEqual({ pool: { asn: 'AS100', burned: true } });

    expect(emit).toHaveBeenCalledWith('node.status-changed', { nodeId: diverse.id, from: 'disabled', to: 'unknown' });
    expect(emit).toHaveBeenCalledWith('node.status-changed', { nodeId: burned.id, from: 'online', to: 'disabled' });
    // Nothing is carried yet, and the notice says so rather than reporting 0/0 as done.
    expect((notices[0] as Extract<SwapNotice, { kind: 'swapped' }>).report.notes).toHaveLength(1);
  });

  it('an empty pool replaces nothing and changes no status', async () => {
    const burned = await makeNode({ name: 'burned', status: 'online', pool: { asn: 'AS100' } });
    await makeNode({ name: 'maintenance', status: 'disabled' });
    const { runner, calls } = runnerMock();
    const notices = await swap(burned.id, runner);
    expect(notices).toEqual([{ kind: 'no-spare', burnedId: burned.id }]);
    expect(calls).toHaveLength(0);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: burned.id } })).status).toBe('online');
    expect(await prisma.nodeBootstrapToken.count()).toBe(0);
  });

  it('an installer that fails leaves the spare disabled and marked, and the burned node in service', async () => {
    const burned = await makeNode({ name: 'burned', status: 'online', pool: { asn: 'AS100' } });
    const spare = await makeNode({ name: 'spare', status: 'disabled', pool: { spare: true, asn: 'AS999' } });
    const runner: AnsibleRunner = { provision: vi.fn(async () => Promise.reject(new Error('ssh refused'))) };
    const notices = await swap(burned.id, runner);
    expect(notices).toEqual([
      { kind: 'failed', burnedId: burned.id, spareId: spare.id, stage: 'promote', error: 'ssh refused' },
    ]);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).status).toBe('disabled');
    expect((await loadColdPool()).map((s) => s.id)).toEqual([spare.id]);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: burned.id } })).status).toBe('online');
  });

  it('the repoint step is the one a later milestone replaces', async () => {
    const burned = await makeNode({ name: 'burned', status: 'online', pool: { asn: 'AS100' } });
    const spare = await makeNode({ name: 'spare', status: 'disabled', pool: { spare: true, asn: 'AS999' } });
    const repoint = vi.fn(async () => ({ carried: 3, total: 3, notes: [] }));
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner: runnerMock().runner, repoint, notify: (n) => notices.push(n), schedule: (fn) => void (scheduled = fn) }),
    );
    c.onAnomaly(anomaly(burned.id));
    scheduled!();
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
    expect(repoint).toHaveBeenCalledWith(burned.id, spare.id);
    expect(notices[0]).toMatchObject({ kind: 'swapped', report: { carried: 3, total: 3 } });
  });

  it('an incident that cleared before the confirmation swaps nothing', async () => {
    const burned = await makeNode({ name: 'burned', status: 'online' });
    await makeNode({ name: 'spare', status: 'disabled', pool: { spare: true } });
    let scheduled: (() => void) | undefined;
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner: runnerMock().runner, notify: () => {}, schedule: (fn) => void (scheduled = fn) }),
    );
    c.onAnomaly(anomaly(burned.id));
    c.onCleared(burned.id);
    scheduled!();
    await new Promise((r) => setTimeout(r, 50));
    expect((await prisma.node.findUniqueOrThrow({ where: { id: burned.id } })).status).toBe('online');
    expect(await prisma.nodeBootstrapToken.count()).toBe(0);
  });
});
