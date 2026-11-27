import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { getLogger } from '../../lib/infra/logger.js';
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
import { observedCores } from '../nodes/nodes.cron.js';
import type { CoreStatus } from '@iceslab/shared';

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
  vi.restoreAllMocks();
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
    // Nothing to carry: an honest 0/0, no notes.
    expect((notices[0] as Extract<SwapNotice, { kind: 'swapped' }>).report).toEqual({ carried: 0, total: 0, notes: [] });
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

  it('the repoint step is injectable', async () => {
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

describe('a swap carries the bindings and the node policy', () => {
  async function profile(name: string, extra: Record<string, unknown> = {}) {
    seq += 1;
    return prisma.profile.create({ data: { name: `${name}-${seq}`, protocol: 'xray', config: {} as never, ...extra } });
  }
  async function policy(rules: { actionKind: string }[] = [{ actionKind: 'direct' }]) {
    seq += 1;
    return prisma.nodePolicy.create({
      data: {
        name: `pol-${seq}`,
        rules: { create: rules.map((r, i) => ({ position: i, matchDomain: ['domain:example.com'], ...r })) },
      },
    });
  }
  async function swapped(burnedId: string) {
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner: runnerMock().runner, notify: (n) => notices.push(n), schedule: (fn) => void (scheduled = fn) }),
    );
    c.onAnomaly(anomaly(burnedId));
    scheduled!();
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
    return notices[0] as Extract<SwapNotice, { kind: 'swapped' }>;
  }
  const pair = async () => ({
    burned: await makeNode({ name: 'burned', status: 'online', pool: { asn: 'AS1' } }),
    spare: await makeNode({ name: 'spare', status: 'disabled', pool: { spare: true, asn: 'AS2' } }),
  });

  it('gives the spare the burned node\'s enabled bindings, without the public address, with a Default host, and tells the push and the cache', async () => {
    const { burned, spare } = await pair();
    const p = await profile('prof');
    const off = await profile('off');
    await prisma.profileNodeBinding.create({
      data: { transport: 'tcp', profileId: p.id, nodeId: burned.id, port: 443, publicHost: 'burned.example.com', publicPort: 8443, overrides: { realityShortIds: ['abc123'] } as never },
    });
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: off.id, nodeId: burned.id, port: 444, enabled: false } });
    const emit = vi.spyOn(eventBus, 'emit');

    const notice = await swapped(burned.id);

    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } });
    expect(onSpare).toHaveLength(1);
    expect(onSpare[0]).toMatchObject({ profileId: p.id, port: 443, overrides: { realityShortIds: ['abc123'] }, publicHost: null, publicPort: null, enabled: true });
    expect(await prisma.host.count({ where: { bindingId: onSpare[0]!.id } })).toBe(1);
    expect(emit).toHaveBeenCalledWith('binding.created', { bindingId: onSpare[0]!.id, profileId: p.id, nodeId: spare.id });
    expect(notice.report).toEqual({ carried: 1, total: 1, notes: [] });
  });

  it('does not give a profile the spare already serves a second binding', async () => {
    const { burned, spare } = await pair();
    const p = await profile('shared');
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: p.id, nodeId: burned.id, port: 443 } });
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: p.id, nodeId: spare.id, port: 8443 } });
    await swapped(burned.id);
    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } });
    expect(onSpare.map((b) => b.port)).toEqual([8443]);
  });

  it('skips a binding whose port the spare already uses and carries the others', async () => {
    const { burned, spare } = await pair();
    const [a, b, other] = [await profile('a'), await profile('b'), await profile('other')];
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: a.id, nodeId: burned.id, port: 443 } });
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: b.id, nodeId: burned.id, port: 8443 } });
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: other.id, nodeId: spare.id, port: 443 } });
    const notice = await swapped(burned.id);
    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id }, orderBy: { port: 'asc' } });
    expect(onSpare.map((x) => [x.profileId, x.port])).toEqual([[other.id, 443], [b.id, 8443]]);
    expect(notice.report).toMatchObject({ carried: 1, total: 2 });
    expect(notice.report.notes).toHaveLength(1);
  });

  it('a binding the spare cannot take is noted and the swap still completes', async () => {
    const { burned, spare } = await pair();
    // The spare has reported its cores, and sing-box is not among them.
    await prisma.node.update({
      where: { id: spare.id },
      data: { cores: observedCores([{ name: 'xray', engine: 'xray', installed: true, running: true } as CoreStatus], new Date().toISOString(), 'amd64') as unknown as object },
    });
    const bad = await profile('needs-singbox', { engine: 'singbox' });
    const good = await profile('plain');
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: bad.id, nodeId: burned.id, port: 443 } });
    await prisma.profileNodeBinding.create({ data: { transport: 'tcp', profileId: good.id, nodeId: burned.id, port: 8443 } });

    const notice = await swapped(burned.id);

    expect(notice.report).toMatchObject({ carried: 1, total: 2 });
    expect(notice.report.notes[0]).toContain('needs-singbox');
    expect((await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } })).map((b) => b.profileId)).toEqual([good.id]);
    const burnedAfter = await prisma.node.findUniqueOrThrow({ where: { id: burned.id } });
    expect(burnedAfter.status).toBe('disabled');
    expect(burnedAfter.hardening).toMatchObject({ pool: { burned: true } });
  });

  it('the burned node\'s policy replaces the spare\'s, policy.changed names the spare, the pool labels stay', async () => {
    const { burned, spare } = await pair();
    const mine = await policy();
    const theirs = await policy();
    await prisma.node.update({ where: { id: burned.id }, data: { policyId: mine.id } });
    await prisma.node.update({ where: { id: spare.id }, data: { policyId: theirs.id } });
    const emit = vi.spyOn(eventBus, 'emit');

    await swapped(burned.id);

    const after = await prisma.node.findUniqueOrThrow({ where: { id: spare.id } });
    expect(after.policyId).toBe(mine.id);
    expect(emit).toHaveBeenCalledWith('policy.changed', { policyId: mine.id, nodeIds: [spare.id] });
    expect(after.hardening).toEqual({ pool: { asn: 'AS2' } });
  });

  it('leaves the spare\'s policy alone when the burned node has none', async () => {
    const { burned, spare } = await pair();
    const theirs = await policy();
    await prisma.node.update({ where: { id: spare.id }, data: { policyId: theirs.id } });
    const emit = vi.spyOn(eventBus, 'emit');
    await swapped(burned.id);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).policyId).toBe(theirs.id);
    expect(emit).not.toHaveBeenCalledWith('policy.changed', expect.anything());
  });

  it('a policy the spare cannot carry out is noted, not assigned, and the swap completes', async () => {
    const { burned, spare } = await pair();
    const warp = await policy([{ actionKind: 'warp' }]);
    await prisma.node.update({ where: { id: burned.id }, data: { policyId: warp.id, warpEnabled: true } });
    const notice = await swapped(burned.id);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).policyId).toBeNull();
    expect(notice.report.notes.join('\n')).toContain('node policy not carried');
    expect((await prisma.node.findUniqueOrThrow({ where: { id: burned.id } })).status).toBe('disabled');
    // WARP is not carried either.
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).warpEnabled).toBe(false);
  });

  it('carries dns only to a spare that has none', async () => {
    const dns = { servers: ['1.1.1.1'] };
    const mineless = await pair();
    await prisma.node.update({ where: { id: mineless.burned.id }, data: { dns: dns as never } });
    await swapped(mineless.burned.id);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: mineless.spare.id } })).dns).toEqual(dns);

    const own = await pair();
    await prisma.node.update({ where: { id: own.burned.id }, data: { dns: dns as never } });
    await prisma.node.update({ where: { id: own.spare.id }, data: { dns: { servers: ['9.9.9.9'] } as never } });
    await swapped(own.burned.id);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: own.spare.id } })).dns).toEqual({ servers: ['9.9.9.9'] });
  });
});

describe('a swap names the cascades that lost a hop', () => {
  async function node(name: string, status: string, pool?: Record<string, unknown>) {
    return makeNode({ name, status, pool });
  }
  async function cascade(name: string) {
    seq += 1;
    return prisma.cascade.create({ data: { name: `${name}-${seq}` } });
  }
  async function swapped(burnedId: string) {
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner: runnerMock().runner, notify: (n) => notices.push(n), schedule: (fn) => void (scheduled = fn) }),
    );
    c.onAnomaly(anomaly(burnedId));
    scheduled!();
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
    return notices[0] as Extract<SwapNotice, { kind: 'swapped' }>;
  }

  it('lists a cascade the burned node is an entry of, a transit of, an exit of, or a legacy hop of, once each, in the notice and the journal', async () => {
    const burned = await node('burned', 'online', { asn: 'AS1' });
    const spare = await node('spare', 'disabled', { spare: true, asn: 'AS2' });
    const other = await node('other', 'online');

    const entry = await cascade('c-entry');
    const pos = await prisma.cascadePosition.create({ data: { cascadeId: entry.id, position: 0 } });
    await prisma.cascadePositionNode.create({ data: { positionId: pos.id, nodeId: burned.id } });

    // Entry AND exit of the same cascade: named once.
    const twice = await cascade('c-twice');
    const pos2 = await prisma.cascadePosition.create({ data: { cascadeId: twice.id, position: 0 } });
    await prisma.cascadePositionNode.create({ data: { positionId: pos2.id, nodeId: burned.id } });
    const dir = await prisma.cascadeDirection.create({ data: { cascadeId: twice.id, tag: 1 } });
    await prisma.cascadeDirectionNode.create({ data: { directionId: dir.id, nodeId: burned.id } });

    const legacy = await cascade('c-legacy');
    await prisma.cascadeHop.create({ data: { cascadeId: legacy.id, nodeId: burned.id, position: 0 } });

    // A cascade the burned node is not part of stays out of the list.
    const unrelated = await cascade('c-unrelated');
    const pos3 = await prisma.cascadePosition.create({ data: { cascadeId: unrelated.id, position: 0 } });
    await prisma.cascadePositionNode.create({ data: { positionId: pos3.id, nodeId: other.id } });

    const warn = vi.spyOn(getLogger(), 'warn');
    const notice = await swapped(burned.id);

    const names = [entry.name, twice.name, legacy.name].sort();
    expect(notice.report.notes).toEqual([`cascades not rewired (the burned node is a hop of ${names.join(', ')})`]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`cascades not rewired, the burned node is a hop of ${names.join(', ')}`));
    expect(notice.report.notes.join()).not.toContain(unrelated.name);

    // Named, not rebuilt: the burned node is still the hop, the spare is in none.
    expect(await prisma.cascadePositionNode.count({ where: { nodeId: burned.id } })).toBe(2);
    expect(await prisma.cascadeDirectionNode.count({ where: { nodeId: burned.id } })).toBe(1);
    expect(await prisma.cascadeHop.count({ where: { nodeId: burned.id } })).toBe(1);
    expect(await prisma.cascadePositionNode.count({ where: { nodeId: spare.id } })).toBe(0);
    expect(await prisma.cascadeDirectionNode.count({ where: { nodeId: spare.id } })).toBe(0);
    expect(await prisma.cascadeHop.count({ where: { nodeId: spare.id } })).toBe(0);
  });

  it('adds no note and no journal line when the burned node is in no cascade', async () => {
    const burned = await node('burned', 'online', { asn: 'AS1' });
    await node('spare', 'disabled', { spare: true, asn: 'AS2' });
    const warn = vi.spyOn(getLogger(), 'warn');
    const notice = await swapped(burned.id);
    expect(notice.report.notes).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cascades not rewired'));
  });
});
