import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import {
  createBinding,
  createProfile,
  updateBinding,
  updateProfile,
  NodeCoreAlreadyServingError,
} from './profiles.service.js';

/**
 * Two profiles of one protocol, deployed to one node.
 *
 * Measured live on n-lab-1 2026-08-30, two mtproto profiles bound at 8443 and
 * 9443. The panel answered 201 to both, the push reported `applied=2,
 * failed=0`, `GET /api/nodes/:id/cores` said `running: true, drift: false`, and
 * the subscription kept emitting the 8443 endpoint with its own secret. On the
 * machine there was ONE mtg process, listening on 9443 only, holding the other
 * profile's secret. Everything an operator can look at was green and one half
 * of their users could not connect.
 *
 * The cause is structural, not mtproto's: every node adapter except xray stores
 * a single inbound (`a.cfg.Inbound` / `a.inbound`), so ApplyInbound overwrites
 * and restarts. xray is the exception because it keys `a.inbounds` by binding id
 * and implements core.InboundReconciler - which is why the guard asks that
 * interface rather than listing protocols, and why node-adapter-keys.mirror.test
 * reads the answer out of the node instead of trusting this file.
 *
 * The cases below are the three doors into the pair. Creation is the obvious
 * one; the other two are the ways a pair that was legal when written becomes
 * illegal without a binding ever being created - enabling, and re-pinning the
 * engine onto a different core.
 */

let seq = 0;

async function makeNode(name: string) {
  seq += 1;
  return prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      status: 'online',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
}

async function makeProfile(
  protocol: string,
  config: Record<string, unknown>,
  opts: { enabled?: boolean; engine?: string | null } = {},
) {
  seq += 1;
  return createProfile({
    name: `${protocol}-${seq}`,
    protocol,
    config: config as never,
    enabled: opts.enabled ?? true,
    ...(opts.engine !== undefined ? { engine: opts.engine } : {}),
  } as never);
}

const mtproto = () => makeProfile('mtproto', { domain: 'www.cloudflare.com' });
const xray = (engine?: string | null) =>
  makeProfile(
    'xray',
    {
      security: 'reality',
      realityPrivateKey: 'MFuvzJnJHqTBLzTBIvGCtDcOdyCYYAiCvxCEHiXcnEo',
      realityPublicKey: 'yZLPo6dK4qMLPvGtwiOELCA1FGnBoM3vPTVAxDvtcHo',
      realityServerNames: ['www.microsoft.com'],
      realityShortIds: ['0123456789abcdef'],
    },
    engine === undefined ? {} : { engine },
  );

describe('a node core that holds one inbound, asked to hold two', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses the second deploy and names the profile already holding the core', async () => {
    const node = await makeNode('n');
    const first = await mtproto();
    const second = await mtproto();
    await createBinding({ profileId: first.id, nodeId: node.id, port: 8443, enabled: true });

    await expect(
      createBinding({ profileId: second.id, nodeId: node.id, port: 9443, enabled: true }),
    ).rejects.toThrow(NodeCoreAlreadyServingError);

    try {
      await createBinding({ profileId: second.id, nodeId: node.id, port: 9443, enabled: true });
      expect.unreachable('the second deploy was accepted');
    } catch (err) {
      const e = err as NodeCoreAlreadyServingError;
      // An operator who only sees "conflict" has no idea which of their
      // profiles is about to go dark, or that a port change will not help.
      expect(e.occupantName).toBe(first.name);
      expect(e.occupantPort).toBe(8443);
      expect(e.nodeName).toBe(node.name);
      expect(e.message).toContain(first.name);
      expect(e.message).toContain(node.name);
      expect(e.message).toContain('8443');
    }
  });

  it('is not the port check wearing another name: a free port is refused too', async () => {
    // The control. If this only ever fired on a taken port it would be
    // PortInUseError with worse wording, and the live measurement - two
    // profiles on 8443 and 9443, both accepted - would still pass.
    const node = await makeNode('n');
    const first = await mtproto();
    const second = await mtproto();
    await createBinding({ profileId: first.id, nodeId: node.id, port: 8443, enabled: true });
    const free = await prisma.profileNodeBinding.findFirst({
      where: { nodeId: node.id, port: 20000 },
    });
    expect(free, 'port 20000 must be free for this case to mean anything').toBeNull();
    await expect(
      createBinding({ profileId: second.id, nodeId: node.id, port: 20000, enabled: true }),
    ).rejects.toThrow(NodeCoreAlreadyServingError);
  });

  it('lets xray hold several, because the xray adapter actually does', async () => {
    const node = await makeNode('n');
    const a = await xray();
    const b = await xray();
    await createBinding({ profileId: a.id, nodeId: node.id, port: 443, enabled: true });
    await expect(
      createBinding({ profileId: b.id, nodeId: node.id, port: 8443, enabled: true }),
    ).resolves.toMatchObject({ port: 8443 });
  });

  it('keys on the (protocol, engine) pair, not the protocol', async () => {
    // The node dispatches on the pair: an xray profile on the native core and
    // one pinned to sing-box land on two different adapters and cannot evict
    // each other, even though both say "xray".
    const node = await makeNode('n');
    const native = await xray();
    const pinned = await xray('singbox');
    await createBinding({ profileId: native.id, nodeId: node.id, port: 443, enabled: true });
    await expect(
      createBinding({ profileId: pinned.id, nodeId: node.id, port: 8443, enabled: true }),
    ).resolves.toMatchObject({ port: 8443 });

    // ...and the same pair twice does collide, because sing-box holds one.
    const alsoPinned = await xray('singbox');
    await expect(
      createBinding({ profileId: alsoPinned.id, nodeId: node.id, port: 2053, enabled: true }),
    ).rejects.toThrow(NodeCoreAlreadyServingError);
  });

  it('leaves two different protocols on one node alone', async () => {
    const node = await makeNode('n');
    const mt = await mtproto();
    const xr = await xray();
    await createBinding({ profileId: mt.id, nodeId: node.id, port: 443, enabled: true });
    await expect(
      createBinding({ profileId: xr.id, nodeId: node.id, port: 8443, enabled: true }),
    ).resolves.toMatchObject({ port: 8443 });
  });

  it('does not count a binding that is not deployed', async () => {
    // Disabled is exactly how an operator gets OUT of a collision, and a guard
    // that judged it would make that move impossible.
    const node = await makeNode('n');
    const off = await mtproto();
    const on = await mtproto();
    await createBinding({ profileId: off.id, nodeId: node.id, port: 8443, enabled: false });
    await expect(
      createBinding({ profileId: on.id, nodeId: node.id, port: 9443, enabled: true }),
    ).resolves.toMatchObject({ port: 9443 });
  });

  it('does not count a binding whose profile is disabled', async () => {
    // The push queue asks for both (`enabled: true, profile: { enabled: true }`),
    // so a guard asking for less would refuse a deploy the node never sees.
    const node = await makeNode('n');
    const off = await makeProfile('mtproto', { domain: 'www.cloudflare.com' }, { enabled: false });
    const on = await mtproto();
    await createBinding({ profileId: off.id, nodeId: node.id, port: 8443, enabled: true });
    await expect(
      createBinding({ profileId: on.id, nodeId: node.id, port: 9443, enabled: true }),
    ).resolves.toMatchObject({ port: 9443 });
  });

  it('second door: enabling a binding that was parked disabled', async () => {
    const node = await makeNode('n');
    const live = await mtproto();
    const parked = await mtproto();
    await createBinding({ profileId: live.id, nodeId: node.id, port: 8443, enabled: true });
    const b = await createBinding({
      profileId: parked.id,
      nodeId: node.id,
      port: 9443,
      enabled: false,
    });
    await expect(updateBinding(b.id, { enabled: true })).rejects.toThrow(
      NodeCoreAlreadyServingError,
    );
    // ...and the same request stays legal once the other side steps aside.
    const other = await prisma.profileNodeBinding.findFirstOrThrow({
      where: { profileId: live.id },
    });
    await updateBinding(other.id, { enabled: false });
    await expect(updateBinding(b.id, { enabled: true })).resolves.toMatchObject({
      enabled: true,
    });
  });

  it('third door: enabling a profile that was bound while disabled', async () => {
    const node = await makeNode('n');
    const live = await mtproto();
    const parked = await makeProfile(
      'mtproto',
      { domain: 'www.google.com' },
      { enabled: false },
    );
    await createBinding({ profileId: live.id, nodeId: node.id, port: 8443, enabled: true });
    await createBinding({ profileId: parked.id, nodeId: node.id, port: 9443, enabled: true });
    await expect(updateProfile(parked.id, { enabled: true })).rejects.toThrow(
      NodeCoreAlreadyServingError,
    );
  });

  it('third door: re-pinning the engine moves a profile onto a core that is taken', async () => {
    // Nothing about the binding changes here. The profile simply stops being
    // dispatched to one adapter and starts being dispatched to another, and
    // that other one is occupied.
    const node = await makeNode('n');
    const occupant = await xray('singbox');
    const mover = await xray();
    await createBinding({ profileId: occupant.id, nodeId: node.id, port: 443, enabled: true });
    await createBinding({ profileId: mover.id, nodeId: node.id, port: 8443, enabled: true });
    await expect(updateProfile(mover.id, { engine: 'singbox' })).rejects.toThrow(
      NodeCoreAlreadyServingError,
    );
    // The move back onto the multi-inbound core is fine.
    await expect(updateProfile(mover.id, { engine: null })).resolves.toMatchObject({
      engine: null,
    });
  });

  it('still lets a pair that predates the guard be edited', async () => {
    // Rows written before this rule are not migrated, so the only way out of a
    // legacy collision is through the panel. An edit that moves neither the
    // engine nor `enabled` must not be re-judged, or renaming one of the two
    // profiles would be refused and the operator would be stuck.
    const node = await makeNode('n');
    const a = await mtproto();
    const b = await mtproto();
    await createBinding({ profileId: a.id, nodeId: node.id, port: 8443, enabled: true });
    await prisma.profileNodeBinding.create({
      data: { profileId: b.id, nodeId: node.id, port: 9443, enabled: true },
    });
    await expect(updateProfile(b.id, { name: `renamed-${seq}` })).resolves.toMatchObject({
      name: `renamed-${seq}`,
    });
    // Disabling one is the way out, and it must stay available.
    await expect(updateProfile(b.id, { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });
});
