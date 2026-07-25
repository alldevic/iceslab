import type {
  Group,
  GroupProfile,
  GroupCascadeExit,
  GroupRoutePolicy,
} from '../../generated/prisma/client.js';

/** A4 increment 2: per-cascade exit allow-list, grouped by cascade for the UI. */
export interface SquadExitAclEntry {
  cascadeId: string;
  exitNodeIds: string[];
}

export interface PublicSquadDto {
  id: string;
  name: string;
  description: string | null;
  /** Slice 27: squad ACL operates on profiles, not per-node inbounds. */
  profileIds: string[];
  /** A4 increment 2: per-cascade allowed exits. Empty = no exit restriction. */
  exitAcl: SquadExitAclEntry[];
  /** A4 ad-split: extra route-policies granted to this squad. Empty = plain only. */
  policyIds: string[];
  /** R3-a: per-squad routing-preset override, or null to inherit the panel default. */
  routingPreset: string | null;
  /** K7: per-squad HWID device-limit default (applies when user has no explicit limit). */
  hwidDeviceLimit: number | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

type SquadWithRelations = Group & {
  groupProfiles: Pick<GroupProfile, 'profileId'>[];
  cascadeExits?: Pick<GroupCascadeExit, 'cascadeId' | 'exitNodeId'>[];
  routePolicies?: Pick<GroupRoutePolicy, 'policyId'>[];
  _count?: { members: number };
};

/** Group flat (cascadeId, exitNodeId) rows into one entry per cascade. */
function groupExitAcl(
  rows: Pick<GroupCascadeExit, 'cascadeId' | 'exitNodeId'>[],
): SquadExitAclEntry[] {
  const byCascade = new Map<string, string[]>();
  for (const r of rows) {
    const list = byCascade.get(r.cascadeId);
    if (list) list.push(r.exitNodeId);
    else byCascade.set(r.cascadeId, [r.exitNodeId]);
  }
  return [...byCascade.entries()].map(([cascadeId, exitNodeIds]) => ({ cascadeId, exitNodeIds }));
}

export function mapSquadToPublic(squad: SquadWithRelations): PublicSquadDto {
  return {
    id: squad.id,
    name: squad.name,
    description: squad.description,
    profileIds: squad.groupProfiles.map((gp) => gp.profileId),
    exitAcl: groupExitAcl(squad.cascadeExits ?? []),
    policyIds: (squad.routePolicies ?? []).map((rp) => rp.policyId),
    routingPreset: squad.routingPreset,
    hwidDeviceLimit: squad.hwidDeviceLimit,
    memberCount: squad._count?.members ?? 0,
    createdAt: squad.createdAt.toISOString(),
    updatedAt: squad.updatedAt.toISOString(),
  };
}
