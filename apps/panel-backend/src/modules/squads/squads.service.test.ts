// The squad rules that everything else stands on, and that nothing tested.
//
// Squad membership is what makes a subscription visible: the binding query is
// keyed on the user's squad set, so a user with no squads has no endpoints, and
// the two system squads are the fixed points the rest is written against. The
// service says so in its own comment — "everything about a user's
// view-of-the-world depends on this squad existing with its known UUID" — and
// until now nothing checked that the guard holding it up was still there.
//
// The delete backstop is the other half: an admin removing a squad must not
// silently take a paying user's access away by leaving them with none. WHICH
// squad they land in is a security decision, not a tidiness one, and it flips
// with the compat facade.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../prisma.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { generateUserCredentials } from '../../lib/credentials.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID } from './squads.constants.js';
import { CreateSquadSchema } from './squads.schemas.js';
import * as squads from './squads.service.js';

/** Create the way the route does — through the schema, so the defaults the
 *  service relies on (hostIds, policyIds, …) are actually there. */
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

describe('the system squads are protected', () => {
  it('refuses to edit or delete either of them', async () => {
    for (const id of [ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID]) {
      await expect(squads.updateSquad(id, { name: 'renamed' })).rejects.toBeInstanceOf(
        squads.SquadProtectedError,
      );
      await expect(squads.updateSquad(id, { profileIds: [] })).rejects.toBeInstanceOf(
        squads.SquadProtectedError,
      );
      await expect(squads.deleteSquad(id)).rejects.toBeInstanceOf(squads.SquadProtectedError);
    }
  });

  it('leaves them intact after a refused call', async () => {
    // A guard that throws AFTER writing is not a guard. "All" auto-tracks every
    // profile, and an emptied profile set is a fleet-wide outage that looks
    // like an ordinary failed request.
    const before = await prisma.group.findUnique({ where: { id: ALL_SQUAD_ID } });
    await expect(squads.updateSquad(ALL_SQUAD_ID, { name: 'renamed' })).rejects.toThrow();
    const after = await prisma.group.findUnique({ where: { id: ALL_SQUAD_ID } });
    expect(after?.name).toBe(before?.name);
    expect(after).not.toBeNull();
  });
});

describe('deleting an ordinary squad', () => {
  it('never leaves a member with no squad at all', async () => {
    // A user with an empty squad set is invisible to the subscription builder:
    // no squads, no bindings, no endpoints. Silently, on an admin's tidy-up.
    const squad = await makeSquad('to-delete');
    const userId = await makeUser('orphan-to-be');
    await prisma.groupMember.create({ data: { groupId: squad.id, userId } });

    await squads.deleteSquad(squad.id);

    const after = await squadsOf(userId);
    expect(after.length, 'the member was left with no squad').toBeGreaterThan(0);
    // Which one is the facade's call, asserted where that decision is made.
    expect([ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID]).toContain(after[0]);
  });

  it('leaves a member who still has another squad where they were', async () => {
    // Backstopping someone who did not need it would hand them whatever the
    // backstop squad reaches — free access under the facade.
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
