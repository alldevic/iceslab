import { eventBus } from '../../lib/event-bus.js';
import { prisma } from '../../prisma.js';
import { config } from '../../config.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID, NO_ACCESS_SQUAD_NAME } from './squads.constants.js';
import type { CreateSquadInput, UpdateSquadInput } from './squads.schemas.js';
import { mapSquadToPublic, type PublicSquadDto } from './squads.mapper.js';

// ───── Domain errors ─────

export class SquadNotFoundError extends Error {
  constructor(public id: string) {
    super(`Squad ${id} not found`);
    this.name = 'SquadNotFoundError';
  }
}

export class SquadAlreadyExistsError extends Error {
  constructor(public name: string) {
    super(`Squad "${name}" already exists`);
    this.name = 'SquadAlreadyExistsError';
  }
}

export class SquadProtectedError extends Error {
  constructor() {
    super('This squad is system-managed and cannot be modified or deleted');
    this.name = 'SquadProtectedError';
  }
}

// ───── Service methods ─────

// Soft-deleted users still keep their `group_members` rows (we only flip
// `users.deletedAt`, the join row stays for restore-ability). So the naive
// `_count: { members: true }` over-counts. Filter to live users only.
const includeRelations = {
  groupProfiles: { select: { profileId: true } },
  groupHosts: { select: { hostId: true } },
  cascadeExits: { select: { cascadeId: true, exitNodeId: true } },
  routePolicies: { select: { policyId: true } },
  _count: {
    select: {
      members: { where: { user: { deletedAt: null } } },
    },
  },
} as const;

// A4 increment 2: flatten the grouped exit ACL into join rows, dropping entries
// with no chosen exits (an empty list = "no restriction", so it stores nothing).
function exitAclRows(
  groupId: string,
  exitAcl: { cascadeId: string; exitNodeIds: string[] }[],
): { groupId: string; cascadeId: string; exitNodeId: string }[] {
  return exitAcl.flatMap((e) =>
    e.exitNodeIds.map((exitNodeId) => ({ groupId, cascadeId: e.cascadeId, exitNodeId })),
  );
}

export async function listSquads(): Promise<PublicSquadDto[]> {
  const rows = await prisma.group.findMany({
    include: includeRelations,
    orderBy: [{ createdAt: 'asc' }],
  });
  return rows.map(mapSquadToPublic);
}

export async function getSquadById(id: string): Promise<PublicSquadDto> {
  const row = await prisma.group.findUnique({
    where: { id },
    include: includeRelations,
  });
  if (!row) throw new SquadNotFoundError(id);
  return mapSquadToPublic(row);
}

export async function createSquad(input: CreateSquadInput): Promise<PublicSquadDto> {
  const existing = await prisma.group.findUnique({ where: { name: input.name } });
  if (existing) throw new SquadAlreadyExistsError(input.name);

  const row = await prisma.group.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      routingPreset: input.routingPreset ?? null,
      hwidDeviceLimit: input.hwidDeviceLimit ?? null,
      groupProfiles: {
        create: input.profileIds.map((profileId) => ({ profileId })),
      },
      // Opt-in narrowing: an empty list means every host of the granted
      // profiles, which is what a squad has always done.
      groupHosts: {
        create: input.hostIds.map((hostId) => ({ hostId })),
      },
      cascadeExits: {
        create: input.exitAcl.flatMap((e) =>
          e.exitNodeIds.map((exitNodeId) => ({
            cascade: { connect: { id: e.cascadeId } },
            node: { connect: { id: exitNodeId } },
          })),
        ),
      },
      routePolicies: {
        create: input.policyIds.map((policyId) => ({ policy: { connect: { id: policyId } } })),
      },
    },
    include: includeRelations,
  });
  eventBus.emit('squad.changed', { squadId: row.id });
  return mapSquadToPublic(row);
}

export async function updateSquad(
  id: string,
  input: UpdateSquadInput,
): Promise<PublicSquadDto> {
  // The "All" squad is system-managed: it auto-tracks every profile (the
  // profile.created handler attaches new profiles to it). Admins can't rename
  // it, can't change its profile set, can't blow it away. Everything else
  // about a user's view-of-the-world depends on this squad existing with its
  // known UUID.
  if (id === ALL_SQUAD_ID || id === NO_ACCESS_SQUAD_ID) throw new SquadProtectedError();

  const existing = await prisma.group.findUnique({ where: { id } });
  if (!existing) throw new SquadNotFoundError(id);

  if (input.name && input.name !== existing.name) {
    const dupe = await prisma.group.findUnique({ where: { name: input.name } });
    if (dupe) throw new SquadAlreadyExistsError(input.name);
  }

  // Profile set replacement, done via tx so concurrent updates can't leave
  // half-applied state. Wipe the join rows, write the new ones.
  const row = await prisma.$transaction(async (tx) => {
    if (input.profileIds !== undefined) {
      await tx.groupProfile.deleteMany({ where: { groupId: id } });
      if (input.profileIds.length > 0) {
        await tx.groupProfile.createMany({
          data: input.profileIds.map((profileId) => ({ groupId: id, profileId })),
        });
      }
    }
    // Replace the host allow-list. An EMPTY array is meaningful here and is
    // not the same as omitting the field: it clears the restriction, putting
    // the squad back to every host of its profiles.
    if (input.hostIds !== undefined) {
      await tx.groupHost.deleteMany({ where: { groupId: id } });
      if (input.hostIds.length > 0) {
        await tx.groupHost.createMany({
          data: input.hostIds.map((hostId) => ({ groupId: id, hostId })),
        });
      }
    }
    // A4 increment 2: replace the exit allow-list (set semantics), same as profiles.
    if (input.exitAcl !== undefined) {
      await tx.groupCascadeExit.deleteMany({ where: { groupId: id } });
      const rows = exitAclRows(id, input.exitAcl);
      if (rows.length > 0) {
        await tx.groupCascadeExit.createMany({ data: rows });
      }
    }
    // A4 ad-split: replace the route-policy grant set (set semantics).
    if (input.policyIds !== undefined) {
      await tx.groupRoutePolicy.deleteMany({ where: { groupId: id } });
      if (input.policyIds.length > 0) {
        await tx.groupRoutePolicy.createMany({
          data: input.policyIds.map((policyId) => ({ groupId: id, policyId })),
        });
      }
    }
    return tx.group.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.routingPreset !== undefined ? { routingPreset: input.routingPreset } : {}),
        ...(input.hwidDeviceLimit !== undefined ? { hwidDeviceLimit: input.hwidDeviceLimit } : {}),
      },
      include: includeRelations,
    });
  });

  // A squad edit changes what its members are handed, and the binding cache is
  // keyed by squad SET rather than by contents, so nothing else would notice.
  eventBus.emit('squad.changed', { squadId: id });
  return mapSquadToPublic(row);
}

export async function deleteSquad(id: string): Promise<void> {
  if (id === ALL_SQUAD_ID || id === NO_ACCESS_SQUAD_ID) throw new SquadProtectedError();
  const existing = await prisma.group.findUnique({ where: { id } });
  if (!existing) throw new SquadNotFoundError(id);

  // Cascade is on for both group_profiles and group_members (see schema).
  // Users who lose their last squad would be invisible to subscription, so they
  // get backstopped into a system group.
  //
  // WHICH system group depends on the compat facade. Natively the fail-OPEN
  // choice ("All") is right: an admin deleting a squad shouldn't silently break
  // those users' subscriptions. But when the Remnawave-compat facade is enabled,
  // squad membership is a paid ENTITLEMENT: promoting a member of a deleted
  // squad to "All" hands them full access for free, and because the facade hides
  // the system groups on read the shop sees activeInternalSquads: [] and cannot
  // even detect it (its repair PATCH targets the now-deleted squad and 400s).
  // With the facade on, fail CLOSED into the no-access group instead.
  const backstopGroupId = config.REMNAWAVE_COMPAT_ENABLED ? NO_ACCESS_SQUAD_ID : ALL_SQUAD_ID;

  await prisma.$transaction(async (tx) => {
    const orphanedUserIds = await tx.groupMember
      .findMany({
        where: { groupId: id },
        select: { userId: true },
      })
      .then((rows) => rows.map((r) => r.userId));

    await tx.group.delete({ where: { id } });

    if (orphanedUserIds.length === 0) return;

    // Find users whose only group was the one we just deleted.
    const remaining = await tx.groupMember.findMany({
      where: { userId: { in: orphanedUserIds } },
      select: { userId: true },
    });
    const stillHaveAGroup = new Set(remaining.map((r) => r.userId));
    const reallyOrphaned = orphanedUserIds.filter((id) => !stillHaveAGroup.has(id));

    if (reallyOrphaned.length > 0) {
      if (backstopGroupId === NO_ACCESS_SQUAD_ID) {
        // The no-access group is created on demand by the facade; make sure it
        // exists before we point orphans at it (FK).
        await tx.group.upsert({
          where: { id: NO_ACCESS_SQUAD_ID },
          update: {},
          create: {
            id: NO_ACCESS_SQUAD_ID,
            name: NO_ACCESS_SQUAD_NAME,
            description:
              'Remnawave-compat: users whose squad set is empty (no access). System-managed, has no profiles — do not edit or assign manually.',
          },
        });
      }
      await tx.groupMember.createMany({
        data: reallyOrphaned.map((userId) => ({ groupId: backstopGroupId, userId })),
        skipDuplicates: true,
      });
    }
  });
}
