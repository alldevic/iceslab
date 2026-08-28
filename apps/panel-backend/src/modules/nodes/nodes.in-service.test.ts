// Taking a node out of service and putting it back.
//
// `status: 'disabled'` had exactly one writer - the F2 cold pool, which sets it
// when it retires a burned node - and no reader that could undo it. The field
// was not in `UpdateNodeSchema`, no editor drew a control for it, and because
// zod strips unknown keys the request an operator would try answered 200 and
// changed nothing:
//
//   PUT /api/nodes/<id> {"status":"active"}  ->  200, status still 'disabled'
//
// Measured against the live panel on 2026-08-29, along with `{"enabled":true}`.
// A disabled node is out of every subscription (`status: { not: 'disabled' }`),
// out of the status poller (`where: { status: { not: 'disabled' } }`) and
// answers `disabled` on its heartbeat, so the only way back was SQL.
//
// The split this restores is the one `UpdateUserSchema` already makes for a
// user: the operator owns active/disabled, the cron owns the rest.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { eventBus } from '../../lib/event-bus.js';
import { UpdateNodeSchema } from './nodes.schemas.js';
import { createNode, updateNode } from './nodes.service.js';

let seq = 0;
async function aNode() {
  const created = await createNode(
    {
      name: `in-service-${++seq}`,
      address: `10.0.0.${++seq}:1337`,
      protocol: 'xray',
      consumptionMultiplier: 1,
      singboxEngine: false,
    },
    { panelUrl: 'https://panel.example.com' },
  );
  return created;
}

/**
 * Every update below goes through the route's own schema first. Calling the
 * service with a hand-built object would skip the half where the bug lived:
 * zod strips unknown keys, so before this fix the field simply vanished between
 * the request and the service and the answer was still 200.
 */
async function save(id: string, body: unknown) {
  return updateNode(id, UpdateNodeSchema.parse(body));
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('the operator half of a node status', () => {
  it('takes only the two values an operator owns', () => {
    expect(UpdateNodeSchema.safeParse({ status: 'disabled' }).success).toBe(true);
    expect(UpdateNodeSchema.safeParse({ status: 'active' }).success).toBe(true);
    // The poller's verdicts are its own. Refused rather than ignored: a request
    // that says one thing and does another is what this whole fix is about.
    for (const owned of ['online', 'degraded', 'unreachable', 'unknown']) {
      expect(
        UpdateNodeSchema.safeParse({ status: owned }).success,
        `${owned} is the poller's answer about the machine, not an operator's`,
      ).toBe(false);
    }
  });

  it('goes out of service and back, and says who did it', async () => {
    const node = await aNode();

    const off = await save(node.id, { status: 'disabled' });
    expect(off.status).toBe('disabled');
    expect(off.lastStatusMessage).toBe('disabled by an operator');

    const on = await save(node.id, { status: 'active' });
    expect(on.status, 'a disabled node could not be put back in service').toBe('active');
    expect(on.lastStatusMessage).toBe('re-enabled by an operator');
  });

  it('re-pushes the config of a node coming back, and does not push one that was only renamed', async () => {
    const node = await aNode();
    await save(node.id, { status: 'disabled' });

    const pushed: string[] = [];
    const onUpdated = (e: { nodeId: string }) => pushed.push(e.nodeId);
    eventBus.on('node.updated', onUpdated);
    try {
      // A node gets no config while it is out - bindings and profiles can move
      // under it - so coming back has to push, exactly as the pool's promote
      // does for a spare it has just provisioned.
      await save(node.id, { status: 'active' });
      expect(pushed, 'a node came back in service without being sent its config').toEqual([node.id]);

      // And the same request shape without a status change stays quiet: this is
      // the guard that the push is keyed on the transition, not on the field
      // being mentioned.
      await save(node.id, { status: 'active', name: `${node.name}-renamed` });
      expect(pushed).toEqual([node.id]);
    } finally {
      // The bus has `on` and no `off`, so the listener has to stop caring
      // rather than stop listening.
      pushed.length = 0;
    }
  });
});
