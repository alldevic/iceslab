import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { updateHost } from './hosts.service.js';
import { PortInUseError } from '../profiles/profiles.service.js';

/**
 * A-259 with A-257: a host moved alone to a port that passed the "is it free"
 * read and meets the unique index on the insert (another save took the port in
 * between). The read is switched off here (`blind`), so the insert meets the
 * index every time: the answer is the port check's 409, not a 500, and nothing
 * of the move is left behind.
 */
const blind = { on: false };
vi.mock('../../prisma.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../prisma.js')>();
  const bindings = new Proxy(orig.prisma.profileNodeBinding, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k !== 'findUnique' || typeof v !== 'function') return v;
      return (args: { where?: { nodeId_port_transport?: unknown } }) =>
        blind.on && args?.where?.nodeId_port_transport ? Promise.resolve(null) : (v as (a: unknown) => unknown).call(t, args);
    },
  });
  const wrapped = new Proxy(orig.prisma, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k === 'profileNodeBinding') return bindings;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { ...orig, prisma: wrapped };
});

beforeEach(async () => {
  await cleanDatabase();
  blind.on = false;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a host moved alone onto a port taken in between', () => {
  it('is the port check\'s refusal, and the host stays where it was', async () => {
    const node = await prisma.node.create({
      data: { name: 'pm-node', address: 'pm.test', protocol: 'xray', heartbeatSecret: Buffer.alloc(32) },
      select: { id: true },
    });
    const config = { security: 'none', subprotocol: 'vless', network: 'raw' };
    const mine = await prisma.profile.create({ data: { name: 'pm-mine', protocol: 'xray', config } });
    const theirs = await prisma.profile.create({ data: { name: 'pm-theirs', protocol: 'xray', config } });
    const b = await prisma.profileNodeBinding.create({ data: { nodeId: node.id, profileId: mine.id, port: 443, transport: 'tcp' } });
    const host = await prisma.host.create({ data: { bindingId: b.id, remark: 'A' } });
    await prisma.host.create({ data: { bindingId: b.id, remark: 'B' } });
    await prisma.profileNodeBinding.create({ data: { nodeId: node.id, profileId: theirs.id, port: 8443, transport: 'tcp' } });

    blind.on = true;
    const err = await updateHost(host.id, { port: 8443 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortInUseError);
    expect((await prisma.host.findUniqueOrThrow({ where: { id: host.id } })).bindingId).toBe(b.id);
    expect(await prisma.profileNodeBinding.count({ where: { profileId: mine.id } })).toBe(1);
  });
});
