import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  loadBurnedNode,
  loadColdPool,
  makeHotswapDeps,
  spareEngines,
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
  coreVersions?: Record<string, string>;
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
      ...(opts.coreVersions ? { coreVersions: opts.coreVersions } : {}),
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

const XRAY_CONFIG = { security: 'none', subprotocol: 'vless', network: 'raw' };
async function makeProfile(name: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.profile.create({ data: { name: `${name}-${seq}`, protocol: 'xray', config: XRAY_CONFIG, ...over } });
}

function runnerMock() {
  const calls: { spare: { id: string; name: string }; vars: ProvisionVars }[] = [];
  const runner: AnsibleRunner = {
    provision: vi.fn(async (spare, vars) => {
      calls.push({ spare, vars });
      return { dryRun: false };
    }),
  };
  return { runner, calls };
}

const noWait = { waitForReport: async () => true, notify: () => {} };

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the cold pool', () => {
  it('is the disabled nodes that never redeemed a token and are not burned, with their labels', async () => {
    const spare = await makeNode({ name: 'cold', status: 'disabled', pool: { asn: 'AS200', provider: 'ovh' }, countryCode: 'DE' });
    await makeNode({ name: 'online', status: 'online' });
    await makeNode({ name: 'redeemed', status: 'disabled', consumed: true }); // had an agent: IP exposed
    await makeNode({ name: 'burned', status: 'disabled', pool: { burned: true } });

    const pool = await loadColdPool();
    expect(pool.map((s) => s.id)).toEqual([spare.id]);
    expect(pool[0]).toMatchObject({ asn: 'AS200', provider: 'ovh', countryCode: 'DE', consumptionMultiplier: 1 });
  });

  it('a deleted node is no burned node', async () => {
    const n = await makeNode({ name: 'gone', status: 'online', extra: { deletedAt: new Date() } });
    expect(await loadBurnedNode(n.id)).toBeNull();
  });
});

describe('spareEngines', () => {
  it('is the spare\'s cores, the burned node\'s, and every engine a carried binding needs', () => {
    expect(
      spareEngines(['amneziawg'], ['xray', 'hysteria'], [
        { protocol: 'xray', engine: 'singbox' },
        { protocol: 'mtproto', engine: null },
      ]),
    ).toEqual(expect.arrayContaining(['xray', 'singbox', 'hysteria', 'amneziawg', 'mtproto']));
  });
});

describe('a swap, end to end against the database', () => {
  it('promotes a diverse spare with all the burned node\'s cores, carries the binding, retires the burned node', async () => {
    const burned = await makeNode({
      name: 'burned',
      status: 'online',
      pool: { asn: 'AS100' },
      countryCode: 'RU',
      intendedEngines: ['xray', 'hysteria'],
      coreVersions: { xray: '26.3.27' },
    });
    const sameAs = await makeNode({ name: 'spare-same-as', status: 'disabled', pool: { asn: 'AS100' } });
    const diverse = await makeNode({ name: 'spare-diverse', status: 'disabled', pool: { asn: 'AS999' }, countryCode: 'RU', intendedEngines: ['singbox'] });
    const p = await makeProfile('vless');
    await prisma.profileNodeBinding.create({
      data: { profileId: p.id, nodeId: burned.id, port: 443, transport: 'tcp', publicHost: 'burned.example.com', publicPort: 8443 },
    });

    const { runner, calls } = runnerMock();
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({ runner, ...noWait, notify: (n) => notices.push(n), schedule: (fn) => void (scheduled = fn) }),
    );
    c.onAnomaly({ nodeId: burned.id, severity: 'critical', bytesThisPoll: 0, expectedBaseline: 1, activeUsers: 0, droppedUsers: 30 });
    expect(scheduled).toBeDefined();
    // The timer, as it would fire; confirm() is queued, so wait for the swap.
    scheduled!();
    await vi.waitFor(async () => expect((await prisma.node.findUniqueOrThrow({ where: { id: burned.id } })).status).toBe('disabled'), { timeout: 10_000 });
    expect(notices).toEqual([
      { kind: 'swapped', burnedId: burned.id, spareId: diverse.id, report: { carried: 1, total: 1, notes: [] } },
    ]);

    // The install got every core: the spare's own and the burned node's set.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.spare.id).toBe(diverse.id);
    expect(calls[0]!.vars.iceslab_engines).toEqual(['xray', 'hysteria', 'singbox']);
    const tok = await prisma.nodeBootstrapToken.findFirst({ where: { nodeId: diverse.id } });
    expect(tok?.token).toBe(calls[0]!.vars.iceslab_bootstrap_token);

    const spareAfter = await prisma.node.findUniqueOrThrow({ where: { id: diverse.id } });
    expect(spareAfter.status).toBe('unknown');
    expect(spareAfter.intendedEngines).toEqual(['xray', 'hysteria', 'singbox']);
    expect(spareAfter.singboxEngine).toBe(true);
    expect(spareAfter.coreVersions).toEqual({ xray: '26.3.27' });

    // The binding moved without the retired machine's public identity, and
    // with the Default host the subscription walks.
    const carried = await prisma.profileNodeBinding.findMany({ where: { nodeId: diverse.id } });
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ profileId: p.id, port: 443, publicHost: null, publicPort: null });
    expect(await prisma.host.count({ where: { bindingId: carried[0]!.id } })).toBe(1);

    const burnedAfter = await prisma.node.findUniqueOrThrow({ where: { id: burned.id } });
    expect(burnedAfter.status).toBe('disabled');
    expect((burnedAfter.hardening as { pool?: { burned?: boolean; asn?: string } }).pool).toEqual({ asn: 'AS100', burned: true });
    expect((await prisma.node.findUniqueOrThrow({ where: { id: sameAs.id } })).status).toBe('disabled');
    // A burned node never comes back as a spare.
    expect((await loadColdPool()).map((s) => s.id)).toEqual([sameAs.id]);
  });

  it('a dry run installs nothing and does not wait for a report', async () => {
    const burned = await makeNode({ name: 'b', status: 'online' });
    const spare = await makeNode({ name: 's', status: 'disabled' });
    const waitForReport = vi.fn(async () => true);
    const deps = makeHotswapDeps({ runner: { provision: async () => ({ dryRun: true }) }, waitForReport });
    await deps.promote({ id: spare.id, name: spare.name, asn: null, provider: null, countryCode: null, consumptionMultiplier: 1 }, burned.id);
    expect(waitForReport).not.toHaveBeenCalled();
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).status).toBe('unknown');
  });

  it('keeps the spare\'s own core-version intent', async () => {
    const burned = await makeNode({ name: 'b', status: 'online', coreVersions: { xray: '26.3.27' } });
    const spare = await makeNode({ name: 's', status: 'disabled', coreVersions: { xray: '26.1.13' } });
    const { runner } = runnerMock();
    await makeHotswapDeps({ runner, ...noWait }).promote(
      { id: spare.id, name: spare.name, asn: null, provider: null, countryCode: null, consumptionMultiplier: 1 },
      burned.id,
    );
    expect((await prisma.node.findUniqueOrThrow({ where: { id: spare.id } })).coreVersions).toEqual({ xray: '26.1.13' });
  });
});

describe('repoint', () => {
  it('leaves a profile the spare already serves alone, and skips a binding that does not fit', async () => {
    const burned = await makeNode({ name: 'b', status: 'online' });
    const spare = await makeNode({ name: 's', status: 'unknown' });
    const [shared, clash, other] = [await makeProfile('shared'), await makeProfile('clash'), await makeProfile('other')];
    await prisma.profileNodeBinding.create({ data: { profileId: shared.id, nodeId: burned.id, port: 443, transport: 'tcp' } });
    await prisma.profileNodeBinding.create({ data: { profileId: shared.id, nodeId: spare.id, port: 8443, transport: 'tcp' } });
    await prisma.profileNodeBinding.create({ data: { profileId: clash.id, nodeId: burned.id, port: 9443, transport: 'tcp' } });
    // the spare already runs something else on 9443
    await prisma.profileNodeBinding.create({ data: { profileId: other.id, nodeId: spare.id, port: 9443, transport: 'tcp' } });

    const report = await makeHotswapDeps(noWait).repoint(burned.id, spare.id);
    expect(report).toMatchObject({ carried: 0, total: 2 });
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain(clash.name);
    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id }, orderBy: { port: 'asc' } });
    expect(onSpare.map((b) => [b.profileId, b.port])).toEqual([[shared.id, 8443], [other.id, 9443]]);
  });

  it('does not carry a binding the operator switched off', async () => {
    const burned = await makeNode({ name: 'b', status: 'online' });
    const spare = await makeNode({ name: 's', status: 'unknown' });
    const p = await makeProfile('off');
    await prisma.profileNodeBinding.create({ data: { profileId: p.id, nodeId: burned.id, port: 443, transport: 'tcp', enabled: false } });
    expect(await makeHotswapDeps(noWait).repoint(burned.id, spare.id)).toMatchObject({ carried: 0, total: 0 });
  });

  it('carries the resolver and registers WARP anew rather than copying the account', async () => {
    const dns = { servers: [{ address: '1.1.1.1' }] };
    const burned = await makeNode({
      name: 'b',
      status: 'online',
      extra: { dns, warpEnabled: true, warpAccount: { secretKey: 'burned-device' } },
    });
    const spare = await makeNode({ name: 's', status: 'unknown' });
    const registerWarp = vi.fn(async () => undefined);
    const report = await makeHotswapDeps({ ...noWait, registerWarp }).repoint(burned.id, spare.id);
    expect(report.notes).toEqual([]);
    expect(registerWarp).toHaveBeenCalledWith(spare.id);
    const after = await prisma.node.findUniqueOrThrow({ where: { id: spare.id } });
    expect(after.dns).toEqual(dns);
    expect(after.warpAccount).toBeNull();
  });

  it('says so when WARP could not be registered', async () => {
    const burned = await makeNode({ name: 'b', status: 'online', extra: { warpEnabled: true } });
    const spare = await makeNode({ name: 's', status: 'unknown' });
    const report = await makeHotswapDeps({
      ...noWait,
      registerWarp: async () => {
        throw new Error('cloudflare said no');
      },
    }).repoint(burned.id, spare.id);
    expect(report.notes).toEqual(['WARP not registered on the spare: cloudflare said no']);
  });
});
