// The "no access" system squad, with the Remnawave facade switched ON (the
// default-off behaviour is in squads.service.test.ts).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, config: { ...actual.config, REMNAWAVE_COMPAT_ENABLED: true } };
});

import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID, NO_ACCESS_SQUAD_NAME } from './squads.constants.js';
import { CreateSquadSchema } from './squads.schemas.js';
import { ensureNoAccessSquad } from './squads.system.js';
import * as squads from './squads.service.js';

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

async function squadsOf(userId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
  return rows.map((r) => r.groupId).sort();
}

const ensure = () => prisma.$transaction((tx) => ensureNoAccessSquad(tx));

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ensureNoAccessSquad', () => {
  it('creates the row once, with no profiles, however often and however parallel', async () => {
    await Promise.all([ensure(), ensure()]);
    await ensure();

    const rows = await prisma.group.findMany({ where: { id: NO_ACCESS_SQUAD_ID }, include: { groupProfiles: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(NO_ACCESS_SQUAD_NAME);
    expect(rows[0]!.groupProfiles).toEqual([]);
  });

  it('takes a name that says what it is when an operator squad holds the name', async () => {
    await squads.createSquad(CreateSquadSchema.parse({ name: NO_ACCESS_SQUAD_NAME }));
    await ensure();
    const row = await prisma.group.findUnique({ where: { id: NO_ACCESS_SQUAD_ID } });
    expect(row?.name).toBe(`${NO_ACCESS_SQUAD_NAME} (system)`);
  });
});

describe('the no-access squad is protected', () => {
  it('refuses to edit or delete it, and leaves it as it was', async () => {
    await ensure();
    await expect(squads.updateSquad(NO_ACCESS_SQUAD_ID, { name: 'renamed' })).rejects.toBeInstanceOf(
      squads.SquadProtectedError,
    );
    await expect(squads.updateSquad(NO_ACCESS_SQUAD_ID, { profileIds: [] })).rejects.toBeInstanceOf(
      squads.SquadProtectedError,
    );
    await expect(squads.deleteSquad(NO_ACCESS_SQUAD_ID)).rejects.toBeInstanceOf(squads.SquadProtectedError);
    const row = await prisma.group.findUnique({ where: { id: NO_ACCESS_SQUAD_ID } });
    expect(row?.name).toBe(NO_ACCESS_SQUAD_NAME);
  });

  it('refuses even when the row has not been created yet', async () => {
    await expect(squads.deleteSquad(NO_ACCESS_SQUAD_ID)).rejects.toBeInstanceOf(squads.SquadProtectedError);
  });
});

describe('deleting an ordinary squad with the facade on', () => {
  it('moves a member who had only that squad into no access, not All', async () => {
    const squad = await squads.createSquad(CreateSquadSchema.parse({ name: 'to-delete' }));
    const orphan = await makeUser('orphan-to-be');
    const kept = await squads.createSquad(CreateSquadSchema.parse({ name: 'kept' }));
    const other = await makeUser('keeps-another');
    await prisma.groupMember.createMany({
      data: [
        { groupId: squad.id, userId: orphan },
        { groupId: squad.id, userId: other },
        { groupId: kept.id, userId: other },
      ],
    });

    await squads.deleteSquad(squad.id);

    expect(await squadsOf(orphan)).toEqual([NO_ACCESS_SQUAD_ID]);
    expect(await squadsOf(orphan)).not.toContain(ALL_SQUAD_ID);
    expect(await squadsOf(other)).toEqual([kept.id]);
  });
});
