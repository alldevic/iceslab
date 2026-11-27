import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/prisma.js';

/**
 * 19.10: nodes, squads and users wired the way a preset reaches a node
 * (squad -> profile -> binding -> node), without going through the API.
 */
let seq = 0;
const next = (): number => ++seq;

export async function makeNode(opts: { dns?: unknown; name?: string } = {}): Promise<{ id: string; name: string }> {
  const n = next();
  const name = opts.name ?? `pn-${n}`;
  const node = await prisma.node.create({
    data: { name, address: `pn-${n}.test`, heartbeatSecret: Buffer.from(randomUUID()), ...(opts.dns ? { dns: opts.dns as object } : {}) },
    select: { id: true, name: true },
  });
  return node;
}

/** A squad whose profile is bound to each of the nodes; `presetId` is its own preset. */
export async function makeSquad(nodeIds: string[], opts: { presetId?: string; enabled?: boolean } = {}): Promise<{ id: string; profileId: string }> {
  const n = next();
  const profile = await prisma.profile.create({
    data: { name: `pp-${n}`, protocol: 'shadowsocks', config: { method: '2022-blake3-aes-128-gcm' }, enabled: opts.enabled ?? true },
    select: { id: true },
  });
  let port = 20000 + n * 10;
  for (const nodeId of nodeIds) {
    await prisma.profileNodeBinding.create({ data: { nodeId, profileId: profile.id, port: port++, transport: 'tcp' } });
  }
  const squad = await prisma.group.create({
    data: { name: `sq-${n}`, ...(opts.presetId ? { customRoutingPresetId: opts.presetId } : {}) },
    select: { id: true },
  });
  await prisma.groupProfile.create({ data: { groupId: squad.id, profileId: profile.id } });
  return { id: squad.id, profileId: profile.id };
}

export async function makeUser(opts: { squadId?: string; presetId?: string } = {}): Promise<{ id: string }> {
  const n = next();
  const user = await prisma.user.create({
    data: {
      shortId: `pu${n}`.padEnd(8, 'x'),
      username: `pu-${n}`,
      subscriptionToken: `tok-${randomUUID()}`,
      hysteriaPassword: 'x',
      amneziawgPrivateKey: 'x',
      amneziawgPublicKey: 'x',
      naivePassword: 'x',
      xrayUuid: randomUUID(),
      ...(opts.presetId ? { customRoutingPresetId: opts.presetId } : {}),
    },
    select: { id: true },
  });
  if (opts.squadId) await prisma.groupMember.create({ data: { groupId: opts.squadId, userId: user.id } });
  return user;
}
