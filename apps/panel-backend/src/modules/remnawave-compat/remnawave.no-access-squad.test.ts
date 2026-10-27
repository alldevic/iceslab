import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID } from '../squads/squads.constants.js';

/**
 * The "no access" squad, with the facade on. A Remnawave shop sells squads:
 * an empty squad set means no access, and a member of a deleted squad must not
 * fall into "All" (full access) for free, where the facade, which hides the
 * system squads, would not even show it.
 *
 * The facade flag is read once, when config loads, so it is set before the
 * first dynamic import (vitest isolates modules per file).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let squads: typeof import('../squads/squads.service.js');
let CreateSquadSchema: typeof import('../squads/squads.schemas.js').CreateSquadSchema;
let cleanDatabase: () => Promise<void>;

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  prisma = (await import('../../prisma.js')).prisma;
  squads = await import('../squads/squads.service.js');
  CreateSquadSchema = (await import('../squads/squads.schemas.js')).CreateSquadSchema;
  cleanDatabase = (await import('../../../tests/helpers/db.js')).cleanDatabase;
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  const { closeRedis } = await import('../../lib/infra/redis.js');
  await prisma.$disconnect();
  await closeRedis();
});

async function makeUser(username: string): Promise<string> {
  const c = generateUserCredentials();
  const u = await prisma.user.create({
    data: {
      username,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
  });
  return u.id;
}

const squadsOf = async (userId: string) =>
  (await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } }))
    .map((r: { groupId: string }) => r.groupId)
    .sort();

describe('the no-access squad (facade on)', () => {
  it('takes a member of a deleted squad, and is made on first need', async () => {
    const squad = await squads.createSquad(CreateSquadSchema.parse({ name: 'paid-tier' }));
    const userId = await makeUser('paid-member');
    await prisma.groupMember.create({ data: { groupId: squad.id, userId } });
    expect(await prisma.group.count({ where: { id: NO_ACCESS_SQUAD_ID } })).toBe(0);

    await squads.deleteSquad(squad.id);

    expect(await squadsOf(userId)).toEqual([NO_ACCESS_SQUAD_ID]);
    expect(await squadsOf(userId)).not.toContain(ALL_SQUAD_ID);
  });

  it('is refused to edit or delete, like "All"', async () => {
    const { ensureNoAccessSquad } = await import('../squads/squads.system.js');
    await ensureNoAccessSquad(prisma);
    await expect(squads.updateSquad(NO_ACCESS_SQUAD_ID, { name: 'renamed' })).rejects.toBeInstanceOf(
      squads.SquadProtectedError,
    );
    await expect(squads.deleteSquad(NO_ACCESS_SQUAD_ID)).rejects.toBeInstanceOf(squads.SquadProtectedError);
  });

  it('is made once when two callers need it at the same time, and survives a squad of that name', async () => {
    const { ensureNoAccessSquad } = await import('../squads/squads.system.js');
    const { NO_ACCESS_SQUAD_NAME } = await import('../squads/squads.constants.js');
    // The squad-name rule refuses the parentheses, so only a row written past
    // the API (an import, a hand edit) can hold the name; it still must not
    // stop the system squad from being made.
    await prisma.group.create({ data: { name: NO_ACCESS_SQUAD_NAME } });
    await Promise.all([ensureNoAccessSquad(prisma), ensureNoAccessSquad(prisma)]);
    const row = await prisma.group.findUnique({ where: { id: NO_ACCESS_SQUAD_ID } });
    expect(row?.name).toBe(`${NO_ACCESS_SQUAD_NAME} (system)`);
  });
});
