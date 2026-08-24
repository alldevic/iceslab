import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { loadColdPool, loadBurnedNode, makeHotswapDeps, type AnsibleRunner } from './pool.service.js';
import { HotswapController } from './pool.hotswap.js';
import { DEFAULT_HOTSWAP_CONFIG, type AnomalyEvent } from './pool.types.js';

let seq = 0;
async function makeNode(opts: {
  name: string;
  status: string;
  pool?: Record<string, unknown>;
  consumed?: boolean;
  countryCode?: string;
}) {
  seq += 1;
  const node = await prisma.node.create({
    data: {
      name: `${opts.name}-${seq}`,
      address: `${opts.name}-${seq}.test:1337`,
      status: opts.status,
      countryCode: opts.countryCode ?? null,
      heartbeatSecret: Buffer.alloc(32),
      ...(opts.pool ? { hardening: { pool: opts.pool } } : {}),
    },
  });
  if (opts.consumed) {
    await prisma.nodeBootstrapToken.create({
      data: {
        nodeId: node.id,
        token: `tok-${node.id}`,
        expiresAt: new Date(Date.now() + 1_000_000),
        consumedAt: new Date(),
      },
    });
  }
  return node;
}

function anomaly(nodeId: string): AnomalyEvent {
  return {
    nodeId,
    severity: 'critical',
    bytesThisPoll: 0,
    expectedBaseline: 1_000_000,
    activeUsers: 0,
    droppedUsers: 30,
  };
}

describe('F2 pool.service (DB-backed hotswap wiring)', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await cleanDatabase();
  });

  it('loadColdPool returns only disabled, never-redeemed, non-burned nodes with labels', async () => {
    const spare = await makeNode({
      name: 'cold-spare',
      status: 'disabled',
      pool: { asn: 'AS200', provider: 'ovh' },
      countryCode: 'DE',
    });
    await makeNode({ name: 'active', status: 'active' }); // not disabled
    await makeNode({ name: 'redeemed', status: 'disabled', consumed: true }); // had an agent → IP exposed
    await makeNode({ name: 'burned', status: 'disabled', pool: { burned: true } }); // retired

    const pool = await loadColdPool();
    expect(pool.map((s) => s.id)).toEqual([spare.id]);
    expect(pool[0]).toMatchObject({
      asn: 'AS200',
      provider: 'ovh',
      countryCode: 'DE',
      consumptionMultiplier: 1,
    });
  });

  it('swaps a burned node to a diverse spare: promote(active)+token, retire(disabled+burned)', async () => {
    const burned = await makeNode({ name: 'rf-burned', status: 'active', pool: { asn: 'AS100' }, countryCode: 'RU' });
    const sameAs = await makeNode({ name: 'spare-sameAS', status: 'disabled', pool: { asn: 'AS100' } });
    const diverse = await makeNode({ name: 'spare-diverse', status: 'disabled', pool: { asn: 'AS999' }, countryCode: 'RU' });

    const runner: AnsibleRunner = { provision: vi.fn(async () => {}) };
    const controller = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true, triggerCount: 1 },
      makeHotswapDeps(runner),
    );

    const res = await controller.onAnomaly(
      anomaly(burned.id),
      await loadColdPool(),
      (await loadBurnedNode(burned.id))!,
    );
    expect(res.acted).toBe(true);
    expect(res.spareId).toBe(diverse.id); // avoided the same-AS spare

    // the runner provisioned the diverse spare with a freshly-minted bootstrap token
    expect(runner.provision).toHaveBeenCalledTimes(1);
    const call = (runner.provision as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].id).toBe(diverse.id);
    const tok = await prisma.nodeBootstrapToken.findFirst({ where: { nodeId: diverse.id } });
    expect(tok?.token).toBe(call[1]);

    // promoted spare → active; burned → disabled + marked burned
    expect((await prisma.node.findUnique({ where: { id: diverse.id } }))?.status).toBe('active');
    const burnedAfter = await prisma.node.findUnique({ where: { id: burned.id } });
    expect(burnedAfter?.status).toBe('disabled');
    expect((burnedAfter?.hardening as { pool?: { burned?: boolean } })?.pool?.burned).toBe(true);

    // the same-AS spare was left untouched (still cold)
    expect((await prisma.node.findUnique({ where: { id: sameAs.id } }))?.status).toBe('disabled');
  });

  it('does not swap when the cold pool is empty', async () => {
    const burned = await makeNode({ name: 'lonely', status: 'active' });
    const runner: AnsibleRunner = { provision: vi.fn(async () => {}) };
    const controller = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true, triggerCount: 1 },
      makeHotswapDeps(runner),
    );
    const res = await controller.onAnomaly(
      anomaly(burned.id),
      await loadColdPool(),
      (await loadBurnedNode(burned.id))!,
    );
    expect(res).toMatchObject({ acted: false, reason: 'no-spare' });
    expect(runner.provision).not.toHaveBeenCalled();
  });
});

/**
 * A hotswap replaces the box, not the operator's intent. The split they
 * authored has to arrive on the spare, or the swap quietly undoes it and the
 * only symptom is traffic leaving the wrong way.
 *
 * What does NOT carry is as deliberate: a channel (the zapret2 desync proxy) is
 * a property of a machine that has to be provisioned on it, and claiming one the
 * spare does not run would point rules at a port nothing answers.
 */
describe('F2 hotswap carries the egress policy', () => {
  const POLICY = [{ geosite: ['ru'], target: 'direct' }];

  async function nodeWith(name: string, status: string, hardening: unknown) {
    seq += 1;
    return prisma.node.create({
      data: {
        name: `${name}-${seq}`,
        address: `${name}-${seq}.test:1337`,
        status,
        heartbeatSecret: Buffer.alloc(32),
        hardening: hardening as never,
      },
    });
  }

  it('moves the policy onto the spare and leaves the channel behind', async () => {
    const burned = await nodeWith('burned', 'active', {
      pool: { asn: 'AS1' },
      egressPolicy: POLICY,
      zapret2: { enabled: true, preset: 'rf-default' },
    });
    const spare = await nodeWith('spare', 'standby', { pool: { asn: 'AS2' } });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await deps.repoint(burned.id, spare.id);

    const after = (await prisma.node.findUnique({ where: { id: spare.id } }))!.hardening as {
      pool?: unknown;
      egressPolicy?: unknown;
      zapret2?: unknown;
    };
    expect(after.egressPolicy).toEqual(POLICY);
    // The spare's own labels survive: this is a merge, not a replacement.
    expect(after.pool).toEqual({ asn: 'AS2' });
    // The desync channel is the burned box's, not the policy's.
    expect(after.zapret2).toBeUndefined();
  });

  it('leaves a spare alone when the burned node had no policy', async () => {
    const burned = await nodeWith('burned-plain', 'active', { pool: { asn: 'AS1' } });
    const spare = await nodeWith('spare-plain', 'standby', { pool: { asn: 'AS2' } });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await deps.repoint(burned.id, spare.id);

    expect((await prisma.node.findUnique({ where: { id: spare.id } }))!.hardening).toEqual({
      pool: { asn: 'AS2' },
    });
  });
});

/**
 * A swap that promotes a node and hands users nothing is the failure this
 * guards. The burned node leaves the subscription the moment retire disables
 * it, but a node only reaches a subscription through a BINDING, and a cold
 * spare has none - it was never provisioned, so nobody ever bound a profile to
 * it. Seen end to end on a live pair, 2026-08-24: every user came back one node
 * short.
 */
describe('F2 hotswap carries the inbound bindings', () => {
  async function node(name: string, status: string) {
    seq += 1;
    return prisma.node.create({
      data: {
        name: `${name}-${seq}`,
        address: `${name}-${seq}.test:1337`,
        status,
        heartbeatSecret: Buffer.alloc(32),
      },
    });
  }
  async function profile(name: string) {
    seq += 1;
    return prisma.profile.create({
      data: { name: `${name}-${seq}`, protocol: 'xray', config: {} as never },
    });
  }

  it('gives the spare the profiles the burned node served', async () => {
    const burned = await node('b', 'active');
    const spare = await node('s', 'standby');
    const p = await profile('prof');
    await prisma.profileNodeBinding.create({
      data: {
        profileId: p.id,
        nodeId: burned.id,
        port: 443,
        // per-MACHINE, must not follow the profile onto another box
        publicHost: 'burned.example.com',
        publicPort: 8443,
        overrides: { realityShortIds: ['abc123'] } as never,
      },
    });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await deps.repoint(burned.id, spare.id);

    const carried = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } });
    expect(carried).toHaveLength(1);
    expect(carried[0].profileId).toBe(p.id);
    expect(carried[0].port).toBe(443);
    expect(carried[0].overrides).toEqual({ realityShortIds: ['abc123'] });
    // The retired machine's public identity stays with it; the spare's own
    // address is what the subscription should now hand out.
    expect(carried[0].publicHost).toBeNull();
    expect(carried[0].publicPort).toBeNull();
    // A binding is not just its row: the subscription walks bindings x hosts,
    // so one without a Default host emits nothing and the swap still hands the
    // user an empty list.
    expect(await prisma.host.count({ where: { bindingId: carried[0].id } })).toBe(1);
  });

  it('leaves a profile the spare already serves alone', async () => {
    const burned = await node('b2', 'active');
    const spare = await node('s2', 'standby');
    const p = await profile('shared');
    await prisma.profileNodeBinding.create({
      data: { profileId: p.id, nodeId: burned.id, port: 443 },
    });
    await prisma.profileNodeBinding.create({
      data: { profileId: p.id, nodeId: spare.id, port: 8443 },
    });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await deps.repoint(burned.id, spare.id);

    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } });
    expect(onSpare).toHaveLength(1);
    expect(onSpare[0].port).toBe(8443); // untouched
  });

  it('skips a binding whose port the spare already uses, and still swaps', async () => {
    const burned = await node('b3', 'active');
    const spare = await node('s3', 'standby');
    const [pa, pb] = [await profile('a'), await profile('b')];
    await prisma.profileNodeBinding.create({
      data: { profileId: pa.id, nodeId: burned.id, port: 443 },
    });
    // the spare already runs something else on 443
    await prisma.profileNodeBinding.create({
      data: { profileId: pb.id, nodeId: spare.id, port: 443 },
    });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await expect(deps.repoint(burned.id, spare.id)).resolves.toBeUndefined();

    const onSpare = await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } });
    expect(onSpare).toHaveLength(1);
    expect(onSpare[0].profileId).toBe(pb.id);
  });

  it('does not carry a binding the operator had switched off', async () => {
    const burned = await node('b4', 'active');
    const spare = await node('s4', 'standby');
    const p = await profile('off');
    await prisma.profileNodeBinding.create({
      data: { profileId: p.id, nodeId: burned.id, port: 443, enabled: false },
    });

    const deps = makeHotswapDeps({ provision: vi.fn() } as unknown as AnsibleRunner);
    await deps.repoint(burned.id, spare.id);

    expect(await prisma.profileNodeBinding.findMany({ where: { nodeId: spare.id } })).toHaveLength(0);
  });
});

