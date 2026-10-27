import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { uniqueViolationOf } from '../../lib/util/unique-violation.js';
import { createSquad, updateSquad, SquadAlreadyExistsError } from '../squads/squads.service.js';
import { CreateSquadSchema, UpdateSquadSchema } from '../squads/squads.schemas.js';
import { createProfile, updateProfile, ProfileNameTakenError } from './profiles.service.js';
import { CreateProfileSchema, UpdateProfileSchema } from './profiles.schemas.js';

/**
 * A-257 tail: a squad or profile write that passed the "is the name free"
 * read and meets the unique index. The read is switched off here (`blind`),
 * so the second write reaches the index every time instead of only when a
 * race happens to land: the error the service reads is the database's own
 * (the pattern of nodes.unique-clash.test.ts).
 *
 * The services read the name through prisma directly, not a repository, so
 * the client is wrapped: a find by NAME on groups or profiles answers "none"
 * while blind; a find by id and every write go through untouched.
 */
const blind = { on: false };
vi.mock('../../prisma.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../prisma.js')>();
  const blinded = (delegate: object) =>
    new Proxy(delegate, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k !== 'findUnique' || typeof v !== 'function') return v;
        return (args: { where?: { name?: unknown } }) =>
          blind.on && args?.where?.name !== undefined ? Promise.resolve(null) : (v as (a: unknown) => unknown).call(t, args);
      },
    });
  const wrapped = new Proxy(orig.prisma, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k === 'group' || k === 'profile') return blinded(v as object);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { ...orig, prisma: wrapped };
});

const squad = (name: string) => CreateSquadSchema.parse({ name, profileIds: [] });
const profile = (name: string) =>
  CreateProfileSchema.parse({ name, protocol: 'shadowsocks', config: { method: '2022-blake3-aes-128-gcm' } });

beforeEach(async () => {
  await cleanDatabase();
  blind.on = false;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

describe('a write that reaches the name index', () => {
  it('the control: the bare write raises P2002 on the index, which without the catch is a 500', async () => {
    await createSquad(squad('same'));
    await createProfile(profile('same'));
    const g = await prisma.group.create({ data: { name: 'same' } }).catch((e: unknown) => e);
    expect(uniqueViolationOf(g)?.index).toBe('groups_name_key');
    const p = await prisma.profile
      .create({ data: { name: 'same', protocol: 'shadowsocks', config: {} as never } })
      .catch((e: unknown) => e);
    expect(uniqueViolationOf(p)?.index).toBe('profiles_name_key');
  });

  it('a squad create is NAME_TAKEN, and nothing half-made stays', async () => {
    await createSquad(squad('same'));
    blind.on = true;
    const err = await createSquad(squad('same')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquadAlreadyExistsError);
    expect(await prisma.group.count({ where: { name: 'same' } })).toBe(1);
  });

  it('a squad rename onto a taken name is NAME_TAKEN', async () => {
    await createSquad(squad('one'));
    const two = await createSquad(squad('two'));
    blind.on = true;
    const err = await updateSquad(two.id, UpdateSquadSchema.parse({ name: 'one' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquadAlreadyExistsError);
  });

  it('a profile create is the name taken, and nothing half-made stays', async () => {
    await createProfile(profile('same'));
    blind.on = true;
    const err = await createProfile(profile('same')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileNameTakenError);
    expect(await prisma.profile.count({ where: { name: 'same' } })).toBe(1);
  });

  it('a profile rename onto a taken name is the name taken', async () => {
    await createProfile(profile('one'));
    const two = await createProfile(profile('two'));
    blind.on = true;
    const err = await updateProfile(two.id, UpdateProfileSchema.parse({ name: 'one' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileNameTakenError);
  });
});
