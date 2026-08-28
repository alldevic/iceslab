// The half of `hideHopsFromSub` nobody had ever set.
//
// The flag decides whether a cascade's transits and exits also appear in a
// subscription as ordinary, standalone picks. Default true: the cascade is the
// only way to reach them, and `getHiddenCascadeNodeIds` is what
// subscription.service consults to leave them out. Unchecking it is a real
// operator choice — those nodes still work on their own, and the cascade just
// additionally offers them behind its "Auto" entry.
//
// Every test in the repo created cascades with the default, so the false branch
// of that query was never executed. A `where` clause that ignored the column
// would have passed the whole suite, and the operator who unchecked the box
// would have found the exits still missing with nothing saying why.
//
// The entry is the case that decides the shape: it is NEVER hidden, whichever
// way the flag is set, because it is what a subscriber connects to.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCascade, deleteCascade, getHiddenCascadeNodeIds, updateCascade } from './cascade.service.js';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { closeRedis } from '../../lib/redis.js';

let seq = 0;
async function node(name: string): Promise<string> {
  seq += 1;
  const row = await prisma.node.create({
    data: {
      name: `${name}-${seq}`,
      address: `${name}-${seq}.test:1337`,
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  return row.id;
}

async function cascade(hideHopsFromSub: boolean, entry: string, exit: string) {
  return createCascade({
    name: `hide-${hideHopsFromSub}-${++seq}`,
    enabled: true,
    hideHopsFromSub,
    autoProfile: false,
    mode: 'chain',
    positions: [{ position: 0, nodeIds: [entry], entryProtocol: 'xray', linkProtocol: 'xray' }],
    directions: [{ nodeIds: [exit] }],
  });
}

beforeEach(async () => {
  await cleanDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('hideHopsFromSub decides whether the exits are also standalone picks', () => {
  it('true (the default) hides the exit and never the entry', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    await cascade(true, entry, exit);

    const hidden = await getHiddenCascadeNodeIds();
    expect(hidden.has(exit), 'the exit leaked into subscriptions as a direct pick').toBe(true);
    expect(hidden.has(entry), 'the entry is what a subscriber connects to').toBe(false);
  });

  it('false keeps the exit visible', async () => {
    const entry = await node('entry');
    const exit = await node('exit');
    await cascade(false, entry, exit);

    const hidden = await getHiddenCascadeNodeIds();
    expect(
      hidden.has(exit),
      'the operator unchecked "hide hops" and the exit is still missing from every subscription',
    ).toBe(false);
    expect(hidden.has(entry)).toBe(false);
  });

  it('a node that is an exit here and an entry there stays visible', async () => {
    // The rule that makes the two sets a subtraction rather than two queries:
    // being an entry anywhere wins. Without it a node serving one cascade's
    // entry and another's exit would vanish from every subscription, taking its
    // own entry line with it.
    const a = await node('a');
    const b = await node('b');
    const c = await node('c');
    await cascade(true, a, b); // b is an exit
    await cascade(true, b, c); // ...and an entry

    const hidden = await getHiddenCascadeNodeIds();
    expect(hidden.has(b), 'a node that is an entry somewhere was hidden anyway').toBe(false);
    expect(hidden.has(c)).toBe(true);
  });

  it('every writer drops the cache, so the answer is never a minute stale', async () => {
    // The set is cached for 60 s, and three functions change it. Each has to
    // invalidate: an operator who unchecks the box and reloads the subscription
    // must not be told to wait.
    const entry = await node('entry');
    const exit = await node('exit');
    const c = await cascade(true, entry, exit);
    expect((await getHiddenCascadeNodeIds()).has(exit)).toBe(true);

    await updateCascade(c.id, { hideHopsFromSub: false });
    expect(
      (await getHiddenCascadeNodeIds()).has(exit),
      'updateCascade left a stale hidden-node cache behind',
    ).toBe(false);

    await updateCascade(c.id, { hideHopsFromSub: true });
    expect((await getHiddenCascadeNodeIds()).has(exit)).toBe(true);

    await deleteCascade(c.id);
    expect(
      (await getHiddenCascadeNodeIds()).has(exit),
      'deleteCascade left a stale hidden-node cache behind',
    ).toBe(false);
  });
});
