import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { telegram } = vi.hoisted(() => ({ telegram: [] as string[] }));
vi.mock('../../lib/notify/telegram-notify.js', async (real) => ({
  ...(await real<typeof import('../../lib/notify/telegram-notify.js')>()),
  notifyTelegramAsync: (text: string) => {
    telegram.push(text);
  },
}));

const { registerCascadeEventHandlers } = await import('./cascade.events.js');
const { eventBus } = await import('../../lib/infra/event-bus.js');
const { getLogger } = await import('../../lib/infra/logger.js');
const { prisma } = await import('../../prisma.js');
const { cleanDatabase } = await import('../../../tests/helpers/db.js');
const { closeRedis } = await import('../../lib/infra/redis.js');

/**
 * A cascade with no live exit refuses its subscribers, and that is invisible
 * from the panel: the operator sees nothing. So the state announces itself: a
 * log line, a Telegram message and `cascade.exits-changed` (forwarded to
 * webhooks, see webhook.events.test.ts).
 *
 * Edge-triggered off `node.status-changed`, which the poller emits AFTER it has
 * written the new status; each case does the same, update first, then emit.
 * Rows are seeded straight into the tables: the shape of the save is not what
 * is under test.
 */

let seq = 0;
async function node(name: string, status: string, extra: { deletedAt?: Date } = {}): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
      status,
      ...extra,
    },
  });
  return row.id;
}

/** `directions`: one entry per direction, its exit nodes (empty = a named outbound). */
async function cascade(
  name: string,
  directions: string[][],
  opts: { enabled?: boolean } = {},
): Promise<string> {
  const entry = await node('entry', 'online');
  const c = await prisma.cascade.create({
    data: { name, enabled: opts.enabled ?? true, mode: 'chain', hideHopsFromSub: true },
  });
  const pos = await prisma.cascadePosition.create({ data: { cascadeId: c.id, position: 0 } });
  await prisma.cascadePositionNode.create({ data: { positionId: pos.id, nodeId: entry } });
  let tag = 0;
  for (const nodeIds of directions) {
    tag += 1;
    const outboundId =
      nodeIds.length === 0
        ? (await prisma.namedOutbound.create({ data: { name: `${name}-out-${tag}`, type: 'vless', config: {} } })).id
        : null;
    const d = await prisma.cascadeDirection.create({ data: { cascadeId: c.id, tag, outboundId } });
    for (const nodeId of nodeIds) {
      await prisma.cascadeDirectionNode.create({ data: { directionId: d.id, nodeId } });
    }
  }
  return c.id;
}

/** What the poller does: write the status, then emit the flip. */
async function flip(nodeId: string, from: string, to: string): Promise<void> {
  await prisma.node.update({ where: { id: nodeId }, data: { status: to } });
  eventBus.emit('node.status-changed', { nodeId, from, to });
  await settle();
}

// The bus has `on` and no `off`: the collector stays subscribed for the file
// and each case clears it first.
const seen: { cascadeId: string; cascadeName: string; live: number; total: number }[] = [];
eventBus.on('cascade.exits-changed', (p) => {
  seen.push(p);
});

/** The bus delivers through a microtask and the handler awaits the database. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
}

beforeEach(async () => {
  await cleanDatabase();
  seen.length = 0;
  telegram.length = 0;
  vi.restoreAllMocks();
  registerCascadeEventHandlers();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a cascade with no live exit says so', () => {
  it('announces the moment the last live exit goes down: event, log, Telegram', async () => {
    const warn = vi.spyOn(getLogger(), 'warn');
    const a = await node('exit', 'online');
    const id = await cascade('dark', [[a]]);
    await flip(a, 'online', 'unreachable');
    expect(seen).toEqual([{ cascadeId: id, cascadeName: 'dark', live: 0, total: 1 }]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"dark" has no live exit (0/1)'))).toBe(true);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('0 of 1');
  });

  it('announces the first exit coming back, with a message that the alert is over', async () => {
    const a = await node('exit', 'unreachable');
    const id = await cascade('back', [[a]]);
    await flip(a, 'unreachable', 'online');
    expect(seen).toEqual([{ cascadeId: id, cascadeName: 'back', live: 1, total: 1 }]);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('again');
    expect(telegram[0]).toContain('1 of 1');
  });

  it('escapes the cascade name in the Telegram text', async () => {
    const a = await node('exit', 'online');
    await cascade('my_cascade*', [[a]]);
    await flip(a, 'online', 'unreachable');
    expect(telegram[0]).toContain('my\\_cascade\\*');
  });

  it('says nothing while the live count moves without crossing an edge (2 -> 1, 2 -> 3)', async () => {
    const a = await node('exit', 'online');
    const b = await node('exit', 'online');
    const c = await node('exit', 'unreachable');
    await cascade('two', [[a], [b]]);
    await cascade('three', [[c]]);
    await flip(a, 'online', 'unreachable');
    expect(seen, 'one exit down out of two is not an outage').toEqual([]);
    // 'three' has a lone dark exit; a second one comes up -> 2 live, not the first.
    const d = await node('exit', 'online');
    await prisma.cascadeDirectionNode.create({
      data: {
        nodeId: d,
        directionId: (await prisma.cascadeDirection.findFirstOrThrow({ where: { cascade: { name: 'three' } } })).id,
      },
    });
    await flip(c, 'unreachable', 'online');
    expect(seen, 'a second live exit is not the first').toEqual([]);
    expect(telegram).toEqual([]);
  });

  it('does not repeat itself while the cascade stays dark (unreachable -> degraded)', async () => {
    const a = await node('exit', 'unreachable');
    await cascade('still-dark', [[a]]);
    await flip(a, 'unreachable', 'degraded');
    expect(seen).toEqual([]);
    expect(telegram).toEqual([]);
  });

  it('counts a degraded exit as no exit', async () => {
    const a = await node('exit', 'online');
    const id = await cascade('deg', [[a]]);
    await flip(a, 'online', 'degraded');
    expect(seen).toEqual([{ cascadeId: id, cascadeName: 'deg', live: 0, total: 1 }]);
    // and a degraded neighbour is not a live one when the other exit drops
    const b = await node('exit', 'degraded');
    const c = await node('exit', 'online');
    const id2 = await cascade('deg2', [[b], [c]]);
    seen.length = 0;
    await flip(c, 'online', 'unreachable');
    expect(seen).toEqual([{ cascadeId: id2, cascadeName: 'deg2', live: 0, total: 2 }]);
  });

  it('does not count a deleted node in the total', async () => {
    const a = await node('exit', 'online');
    const gone = await node('exit', 'unreachable', { deletedAt: new Date() });
    const id = await cascade('trim', [[a], [gone]]);
    await flip(a, 'online', 'unreachable');
    expect(seen).toEqual([{ cascadeId: id, cascadeName: 'trim', live: 0, total: 1 }]);
  });

  it('says nothing about a disabled cascade', async () => {
    const a = await node('exit', 'online');
    await cascade('off', [[a]], { enabled: false });
    await flip(a, 'online', 'unreachable');
    expect(seen).toEqual([]);
    expect(telegram).toEqual([]);
  });

  it('says nothing about a node that is not an exit (an entry)', async () => {
    const a = await node('exit', 'online');
    const id = await cascade('entry-only', [[a]]);
    const entry = (await prisma.cascadePositionNode.findFirstOrThrow({ where: { position: { cascadeId: id } } })).nodeId;
    await flip(entry, 'online', 'unreachable');
    expect(seen).toEqual([]);
  });

  it('leaves a direction on a named outbound out of the count', async () => {
    const a = await node('exit', 'online');
    const id = await cascade('mixed', [[a], []]);
    await flip(a, 'online', 'unreachable');
    expect(seen, 'the outbound is not a node: total 1, live 0').toEqual([
      { cascadeId: id, cascadeName: 'mixed', live: 0, total: 1 },
    ]);
  });

  it('does not report a cascade the panel already treats as dead', async () => {
    const a = await node('exit', 'online');
    await cascade('owner', [[a]]);
    await new Promise((r) => setTimeout(r, 5));
    await cascade('shadowed', [[a]]);
    await flip(a, 'online', 'unreachable');
    expect(seen.map((s) => s.cascadeName)).toEqual(['owner']);
  });

  it('a failed lookup is logged and does not stop the other handlers of the event', async () => {
    const a = await node('exit', 'online');
    await cascade('boom', [[a]]);
    const error = vi.spyOn(getLogger(), 'error');
    vi.spyOn(prisma.cascadeDirection, 'findMany').mockRejectedValueOnce(new Error('db down'));
    let other = 0;
    eventBus.on('node.status-changed', () => {
      other += 1;
    });
    await flip(a, 'online', 'unreachable');
    expect(seen).toEqual([]);
    expect(other).toBe(1);
    expect(error.mock.calls.some((c) => String(c[1]).includes('lookup failed'))).toBe(true);
  });
});
