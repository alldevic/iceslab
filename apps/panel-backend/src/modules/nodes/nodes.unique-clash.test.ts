import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { createNode, updateNode, NodeAlreadyExistsError } from './nodes.service.js';
import { CreateNodeSchema } from './nodes.schemas.js';

/**
 * A-127 tail: a create that passed the app-level checks and meets the partial
 * unique index (two creates at once) has to say WHICH one it hit. It used to
 * read `meta.target`, which the pg adapter does not fill, and every clash came
 * out as "name", an address clash included.
 *
 * The app-level checks are switched off here (`blind`), so the second create
 * reaches the index every time instead of only when a race happens to land:
 * the error the service reads is the database's own, not a hand-made meta.
 */
const blind = { on: false };
vi.mock('./nodes.repository.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./nodes.repository.js')>();
  return {
    ...orig,
    findActiveByName: (name: string) => (blind.on ? Promise.resolve(null) : orig.findActiveByName(name)),
    findActiveByAddress: (address: string) => (blind.on ? Promise.resolve(null) : orig.findActiveByAddress(address)),
  };
});

const ctx = { panelUrl: 'https://panel.test' };
const input = (name: string, address: string) => CreateNodeSchema.parse({ name, address, protocol: 'xray' });

beforeEach(async () => {
  await cleanDatabase();
  blind.on = false;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a create that reaches the unique index', () => {
  it('names the address when the address clashed', async () => {
    await createNode(input('first', 'same.example.com:1337'), ctx);
    blind.on = true;
    const err = await createNode(input('second', 'same.example.com:1337'), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeAlreadyExistsError);
    expect((err as NodeAlreadyExistsError).field).toBe('address');
    expect(await prisma.node.count()).toBe(1);
  });

  it('names the name when the name clashed', async () => {
    await createNode(input('same', 'a.example.com:1337'), ctx);
    blind.on = true;
    const err = await createNode(input('same', 'b.example.com:1337'), ctx).catch((e: unknown) => e);
    expect((err as NodeAlreadyExistsError).field).toBe('name');
  });

  it('names the address on an edit too, where a clash used to be a 500', async () => {
    await createNode(input('one', 'one.example.com:1337'), ctx);
    const two = await createNode(input('two', 'two.example.com:1337'), ctx);
    blind.on = true;
    const err = await updateNode(two.id, { address: 'one.example.com:1337' } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeAlreadyExistsError);
    expect((err as NodeAlreadyExistsError).field).toBe('address');
  });

  it('lets a soft-deleted node give its address away (the indexes are partial)', async () => {
    await createNode(input('old', 'reused.example.com:1337'), ctx);
    await prisma.node.updateMany({ data: { deletedAt: new Date() } });
    await expect(createNode(input('new', 'reused.example.com:1337'), ctx)).resolves.toBeDefined();
  });
});
