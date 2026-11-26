// The squad rules that everything else stands on.
//
// Squad membership is what makes a subscription visible: the binding query is
// keyed on the user's squad set, so a user with no squads has no endpoints, and
// the "All" squad is the fixed point the rest is written against. The service
// says so itself ("everything about a user's view-of-the-world depends on this
// squad existing with its known UUID"), and nothing checked that the guard
// holding it up was still there.
//
// The delete backstop is the other half: an admin removing a squad must not
// silently take a paying user's access away by leaving them with none. In this
// codebase the backstop is the "All" squad.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/auth/credentials.js';
import { ALL_SQUAD_ID } from './squads.constants.js';
import { CreateSquadSchema, UpdateSquadSchema } from './squads.schemas.js';
import * as squads from './squads.service.js';

/** Create the way the route does: through the schema, so the defaults the
 *  service relies on (hostIds, policyIds, ...) are actually there. */
function makeSquad(name: string): Promise<{ id: string }> {
  return squads.createSquad(CreateSquadSchema.parse({ name }));
}

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

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('creating and editing a squad', () => {
  it('refuses a second squad with the same name', async () => {
    await makeSquad('twin');
    await expect(makeSquad('twin')).rejects.toBeInstanceOf(squads.SquadAlreadyExistsError);
  });

  it('refuses a rename onto another squad’s name, and keeps the old name', async () => {
    await makeSquad('taken');
    const other = await makeSquad('other');

    await expect(squads.updateSquad(other.id, { name: 'taken' })).rejects.toBeInstanceOf(
      squads.SquadAlreadyExistsError,
    );
    expect((await squads.getSquadById(other.id)).name).toBe('other');
  });

  it('lets a squad keep its own name on an edit that repeats it', async () => {
    const s = await makeSquad('same');
    const out = await squads.updateSquad(s.id, UpdateSquadSchema.parse({ name: 'same', description: 'd' }));
    expect(out.name).toBe('same');
    expect(out.description).toBe('d');
  });

  it('answers SquadNotFoundError for an edit of a squad that does not exist', async () => {
    await expect(
      squads.updateSquad(ALL_SQUAD_ID.replace(/1$/, '9'), { name: 'x' }),
    ).rejects.toBeInstanceOf(squads.SquadNotFoundError);
  });
});

describe('the All squad is protected', () => {
  it('refuses to edit or delete it', async () => {
    await expect(squads.updateSquad(ALL_SQUAD_ID, { name: 'renamed' })).rejects.toBeInstanceOf(
      squads.SquadProtectedError,
    );
    await expect(squads.updateSquad(ALL_SQUAD_ID, { profileIds: [] })).rejects.toBeInstanceOf(
      squads.SquadProtectedError,
    );
    await expect(squads.deleteSquad(ALL_SQUAD_ID)).rejects.toBeInstanceOf(squads.SquadProtectedError);
  });

  it('leaves it intact after a refused call', async () => {
    // A guard that throws AFTER writing is not a guard. "All" auto-tracks every
    // profile, and an emptied profile set is a fleet-wide outage that looks
    // like an ordinary failed request.
    const before = await prisma.group.findUnique({ where: { id: ALL_SQUAD_ID } });
    expect(before, 'the fixture has no All squad').not.toBeNull();
    await expect(squads.updateSquad(ALL_SQUAD_ID, { name: 'renamed' })).rejects.toThrow();
    await expect(squads.deleteSquad(ALL_SQUAD_ID)).rejects.toThrow();
    const after = await prisma.group.findUnique({ where: { id: ALL_SQUAD_ID } });
    expect(after?.name).toBe(before?.name);
  });
});

describe('deleting an ordinary squad', () => {
  it('moves a member who had only that squad into All', async () => {
    // A user with an empty squad set is invisible to the subscription builder:
    // no squads, no bindings, no endpoints. Silently, on an admin's tidy-up.
    const squad = await makeSquad('to-delete');
    const userId = await makeUser('orphan-to-be');
    await prisma.groupMember.create({ data: { groupId: squad.id, userId } });

    await squads.deleteSquad(squad.id);

    expect(await squadsOf(userId), 'the member was left with no squad or in the wrong one').toEqual([
      ALL_SQUAD_ID,
    ]);
    expect(await prisma.group.findUnique({ where: { id: squad.id } })).toBeNull();
  });

  it('leaves a member who still has another squad where they were', async () => {
    // Backstopping someone who did not need it would hand them whatever All
    // reaches on top of what they were granted.
    const doomed = await makeSquad('doomed');
    const kept = await makeSquad('kept');
    const userId = await makeUser('has-two-squads');
    await prisma.groupMember.createMany({
      data: [
        { groupId: doomed.id, userId },
        { groupId: kept.id, userId },
      ],
    });

    await squads.deleteSquad(doomed.id);

    expect(await squadsOf(userId)).toEqual([kept.id]);
  });

  it('still refuses a squad that does not exist', async () => {
    await expect(squads.deleteSquad(ALL_SQUAD_ID.replace(/1$/, '9'))).rejects.toBeInstanceOf(
      squads.SquadNotFoundError,
    );
  });
});
