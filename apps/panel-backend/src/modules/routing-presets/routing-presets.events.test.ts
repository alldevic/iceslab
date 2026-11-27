import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { makeNode, makeSquad, makeUser } from '../../../tests/helpers/preset-nodes.js';
import { inboundSyncQueue } from '../inbounds/inbounds.queue.js';
import { registerRoutingPresetEventHandlers, routingPresetEventsIdle } from './routing-presets.events.js';

/**
 * 19.11: the carried DNS rules follow the events of squads and bindings. The
 * events are emitted by hand after the rows were written, as the services do.
 */
beforeEach(async () => {
  await cleanDatabase();
  await inboundSyncQueue.obliterate({ force: true });
  registerRoutingPresetEventHandlers();
});
afterAll(async () => {
  await inboundSyncQueue.obliterate({ force: true });
  await prisma.$disconnect();
  await closeRedis();
});

const rule = (match: string, server: string) => ({ match: [match], server, note: '' });
const preset = async (name: string, ...rules: ReturnType<typeof rule>[]) =>
  (await prisma.routingPreset.create({ data: { name, dnsRules: rules }, select: { id: true } })).id;
const carried = async (nodeId: string) => (await prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { presetDnsRules: true } })).presetDnsRules;
const left = async (nodeId: string) => (await prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { presetDnsConflicts: true } })).presetDnsConflicts;
const queued = async (nodeId: string) => !!(await inboundSyncQueue.getJob(`apply-${nodeId}`));
const settle = async () => {
  await routingPresetEventsIdle();
};
const rows = (id: string) => [{ presetId: id, rules: [{ match: ['example.com'], server: '10.99.0.1' }] }];

describe('a binding appears or goes', () => {
  it('a profile bound to a new node of the squad brings the preset rules to it, and unbinding takes them off', async () => {
    const [n1, n2] = [await makeNode(), await makeNode()];
    const p = await preset('A', rule('example.com', '10.99.0.1'));
    const squad = await makeSquad([n1.id], { presetId: p });
    expect(await carried(n2.id)).toBeNull();

    const binding = await prisma.profileNodeBinding.create({ data: { nodeId: n2.id, profileId: squad.profileId, port: 29999, transport: 'tcp' } });
    eventBus.emit('binding.created', { bindingId: binding.id, profileId: squad.profileId, nodeId: n2.id });
    await settle();
    expect(await carried(n2.id)).toEqual(rows(p));
    expect(await queued(n2.id)).toBe(true);
    // n1 was not recomputed by this event (a binding names one node): nothing carried there yet.
    expect(await carried(n1.id)).toBeNull();

    await inboundSyncQueue.obliterate({ force: true });
    await prisma.profileNodeBinding.delete({ where: { id: binding.id } });
    eventBus.emit('binding.deleted', { bindingId: binding.id, profileId: squad.profileId, nodeId: n2.id });
    await settle();
    expect(await carried(n2.id)).toBeNull();
    expect(await queued(n2.id)).toBe(true);
  });

  it('an event that changes no carried rules queues nothing', async () => {
    const n = await makeNode();
    const other = await makeNode();
    const p = await preset('A', rule('example.com', '10.99.0.1'));
    const squad = await makeSquad([n.id], { presetId: p });
    eventBus.emit('binding.updated', { bindingId: 'x', profileId: squad.profileId, nodeId: n.id });
    await settle();
    expect(await carried(n.id)).toEqual(rows(p));
    expect(await queued(n.id)).toBe(true);

    await inboundSyncQueue.obliterate({ force: true });
    eventBus.emit('binding.updated', { bindingId: 'x', profileId: squad.profileId, nodeId: n.id });
    eventBus.emit('squad.changed', { squadId: squad.id });
    eventBus.emit('profile.updated', { profileId: squad.profileId });
    eventBus.emit('binding.created', { bindingId: 'y', profileId: squad.profileId, nodeId: other.id });
    await settle();
    expect(await queued(n.id)).toBe(false);
    expect(await queued(other.id)).toBe(false);
    expect(await carried(other.id)).toBeNull();
  });
});

describe('a squad changes its profiles', () => {
  it('swapping the profile moves the rules from the old nodes to the new ones', async () => {
    const [old, fresh] = [await makeNode(), await makeNode()];
    const p = await preset('A', rule('example.com', '10.99.0.1'));
    const squad = await makeSquad([old.id], { presetId: p });
    const spare = await makeSquad([fresh.id]); // a squad with no preset, only for its profile
    eventBus.emit('squad.changed', { squadId: squad.id });
    await settle();
    expect(await carried(old.id)).toEqual(rows(p));

    await inboundSyncQueue.obliterate({ force: true });
    await prisma.groupProfile.deleteMany({ where: { groupId: squad.id } });
    await prisma.groupProfile.create({ data: { groupId: squad.id, profileId: spare.profileId } });
    eventBus.emit('squad.changed', { squadId: squad.id });
    await settle();
    expect(await carried(old.id)).toBeNull();
    expect(await carried(fresh.id)).toEqual(rows(p));
    expect(await queued(old.id)).toBe(true);
    expect(await queued(fresh.id)).toBe(true);
  });

  it('a deleted profile takes its nodes off, and a user with an own preset who changes squads moves it', async () => {
    const [n1, n2] = [await makeNode(), await makeNode()];
    const p = await preset('U', rule('example.com', '10.99.0.1'));
    const s1 = await makeSquad([n1.id]);
    const s2 = await makeSquad([n2.id]);
    const user = await makeUser({ squadId: s1.id, presetId: p });
    eventBus.emit('user.updated', { userId: user.id, changes: ['groupIds'] });
    await settle();
    expect(await carried(n1.id)).toEqual(rows(p));
    expect(await carried(n2.id)).toBeNull();

    await prisma.groupMember.deleteMany({ where: { userId: user.id } });
    await prisma.groupMember.create({ data: { groupId: s2.id, userId: user.id } });
    eventBus.emit('user.updated', { userId: user.id, changes: ['groupIds'] });
    await settle();
    expect(await carried(n1.id)).toBeNull();
    expect(await carried(n2.id)).toEqual(rows(p));

    await prisma.profile.delete({ where: { id: s2.profileId } });
    eventBus.emit('profile.deleted', { profileId: s2.profileId, affectedNodeIds: [n2.id] });
    await settle();
    expect(await carried(n2.id)).toBeNull();
  });

  it('a user without an own preset changing squads recomputes nothing', async () => {
    const n = await makeNode();
    const s = await makeSquad([n.id]);
    const user = await makeUser({ squadId: s.id });
    eventBus.emit('user.updated', { userId: user.id, changes: ['groupIds'] });
    await settle();
    expect(await queued(n.id)).toBe(false);
  });
});

describe('a conflict that came from a change of nodes', () => {
  /** Two squads with a preset each, naming one name with two servers, on nodes that do not meet yet. */
  async function apart() {
    const [shared, a] = [await makeNode({ name: 'meet-node' }), await makeNode()];
    const pa = await preset('Alpha', rule('example.com', '10.99.0.1'));
    const pb = await preset('Beta', rule('example.com', '10.99.0.2'), rule('beta-only.com', '10.99.0.2'));
    const sa = await makeSquad([a.id], { presetId: pa });
    const sb = await makeSquad([shared.id], { presetId: pb });
    eventBus.emit('squad.changed', { squadId: sa.id });
    await settle();
    return { shared, a, pa, pb, sa, sb };
  }

  it('does not fail the listener: the preset that came first keeps the node, the clashing rule is left out and recorded', async () => {
    const { shared, pa, pb, sa } = await apart();
    expect(await carried(shared.id)).toEqual([
      { presetId: pb, rules: [{ match: ['example.com'], server: '10.99.0.2' }, { match: ['beta-only.com'], server: '10.99.0.2' }] },
    ]);
    // Alpha's squad is given the shared node too.
    const binding = await prisma.profileNodeBinding.create({ data: { nodeId: shared.id, profileId: sa.profileId, port: 29998, transport: 'tcp' } });
    await inboundSyncQueue.obliterate({ force: true });
    eventBus.emit('binding.created', { bindingId: binding.id, profileId: sa.profileId, nodeId: shared.id });
    await settle();
    // Beta was there first: it stays whole, Alpha's rule is not carried, and the node says so.
    expect(await carried(shared.id)).toEqual([
      { presetId: pb, rules: [{ match: ['example.com'], server: '10.99.0.2' }, { match: ['beta-only.com'], server: '10.99.0.2' }] },
    ]);
    expect(await left(shared.id)).toEqual([{ kind: 'conflict', presetId: pa, otherPresetId: pb, domain: 'example.com', server: '10.99.0.1' }]);
    // Nothing the node carries changed, so nothing is pushed for the record alone.
    expect(await queued(shared.id)).toBe(false);

    // The same event again: same plan, same record, still silent.
    eventBus.emit('binding.created', { bindingId: binding.id, profileId: sa.profileId, nodeId: shared.id });
    await settle();
    expect(await left(shared.id)).toHaveLength(1);
    expect(await queued(shared.id)).toBe(false);

    // The conflict goes with the binding that made it.
    await prisma.profileNodeBinding.delete({ where: { id: binding.id } });
    eventBus.emit('binding.deleted', { bindingId: binding.id, profileId: sa.profileId, nodeId: shared.id });
    await settle();
    expect(await left(shared.id)).toBeNull();
  });

  it('a node with its own 15 servers carries what fits, and records the preset left out', async () => {
    const node = await makeNode({ name: 'full', dns: { servers: Array.from({ length: 15 }, (_, i) => ({ address: `10.1.0.${i + 1}`, domains: [], expectIps: [], skipFallback: false })) } });
    const pa = await preset('Alpha', rule('a.com', '10.2.0.1'));
    const pb = await preset('Beta', rule('b.com', '10.2.0.2'), rule('c.com', '10.2.0.3'));
    const sa = await makeSquad([node.id], { presetId: pa });
    eventBus.emit('squad.changed', { squadId: sa.id });
    await settle();
    expect(await carried(node.id)).toEqual([{ presetId: pa, rules: [{ match: ['a.com'], server: '10.2.0.1' }] }]);
    await makeSquad([node.id], { presetId: pb });
    eventBus.emit('squad.changed', { squadId: sa.id });
    await settle();
    expect(await carried(node.id)).toEqual([{ presetId: pa, rules: [{ match: ['a.com'], server: '10.2.0.1' }] }]);
    expect(await left(node.id)).toEqual([{ kind: 'limit', presetId: pb, count: 18 }]);
  });
});

describe('a new node', () => {
  it('takes the panel-wide rules at creation and is pushed with them', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'subscriptionDnsRules' },
      update: { value: [rule('example.com', '10.99.0.1')] },
      create: { key: 'subscriptionDnsRules', value: [rule('example.com', '10.99.0.1')] },
    });
    const n = await makeNode();
    eventBus.emit('node.created', { nodeId: n.id, nodeName: 'new' });
    await settle();
    expect(await carried(n.id)).toEqual([{ presetId: null, rules: [{ match: ['example.com'], server: '10.99.0.1' }] }]);
    expect(await queued(n.id)).toBe(true);
  });
});
