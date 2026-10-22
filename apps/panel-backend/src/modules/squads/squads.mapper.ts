import type {
  Group,
  GroupProfile,
  GroupHost,
  GroupCascadeExit,
  GroupCascadeOff,
  GroupRoutePolicy,
} from '../../generated/prisma/client.js';

/** A4 increment 2: per-cascade exit allow-list, grouped by cascade for the UI.
 *  A-149: `directionIds` is the list. `exitNodeIds` is derived for the screen
 *  that has not moved yet: the current pool of each allowed direction (and the
 *  node of a legacy hop row). */
export interface SquadExitAclEntry {
  cascadeId: string;
  directionIds: string[];
  exitNodeIds: string[];
}

type ExitRowView = Pick<GroupCascadeExit, 'cascadeId' | 'directionId' | 'exitNodeId'> & {
  direction?: { nodes: { nodeId: string }[] } | null;
};

export interface PublicSquadDto {
  id: string;
  name: string;
  description: string | null;
  /** Slice 27: squad ACL operates on profiles, not per-node inbounds. */
  profileIds: string[];
  /** Which HOSTS of those profiles this squad hands out. EMPTY MEANS ALL, not
   *  none: the list is an opt-in restriction, like `exitAcl`. */
  hostIds: string[];
  /** A4 increment 2: per-cascade allowed exits. A cascade absent = every exit;
   *  an entry with `exitNodeIds: []` = the cascade is off for this squad. */
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
  groupHosts?: Pick<GroupHost, 'hostId'>[];
  cascadeExits?: ExitRowView[];
  cascadesOff?: Pick<GroupCascadeOff, 'cascadeId'>[];
  routePolicies?: Pick<GroupRoutePolicy, 'policyId'>[];
  _count?: { members: number };
};

/** Group flat rows into one entry per cascade, and add an empty entry for
 *  every cascade switched off. A row with neither key (a deleted direction)
 *  still makes the entry exist: restricted to nothing, as the subscription
 *  reads it. */
function groupExitAcl(rows: ExitRowView[], off: Pick<GroupCascadeOff, 'cascadeId'>[]): SquadExitAclEntry[] {
  const byCascade = new Map<string, { directionIds: Set<string>; exitNodeIds: Set<string> }>();
  for (const r of rows) {
    const e = byCascade.get(r.cascadeId) ?? { directionIds: new Set<string>(), exitNodeIds: new Set<string>() };
    if (r.directionId) e.directionIds.add(r.directionId);
    for (const n of r.direction?.nodes ?? []) e.exitNodeIds.add(n.nodeId);
    if (r.exitNodeId) e.exitNodeIds.add(r.exitNodeId);
    byCascade.set(r.cascadeId, e);
  }
  // Written together and replaced together, so a cascade cannot be in both;
  // were it ever, "off" wins here as it does in the subscription: less access.
  for (const o of off) byCascade.set(o.cascadeId, { directionIds: new Set(), exitNodeIds: new Set() });
  return [...byCascade.entries()].map(([cascadeId, e]) => ({
    cascadeId,
    directionIds: [...e.directionIds],
    exitNodeIds: [...e.exitNodeIds],
  }));
}

export function mapSquadToPublic(squad: SquadWithRelations): PublicSquadDto {
  return {
    id: squad.id,
    name: squad.name,
    description: squad.description,
    profileIds: squad.groupProfiles.map((gp) => gp.profileId),
    hostIds: (squad.groupHosts ?? []).map((gh) => gh.hostId),
    exitAcl: groupExitAcl(squad.cascadeExits ?? [], squad.cascadesOff ?? []),
    policyIds: (squad.routePolicies ?? []).map((rp) => rp.policyId),
    routingPreset: squad.routingPreset,
    hwidDeviceLimit: squad.hwidDeviceLimit,
    memberCount: squad._count?.members ?? 0,
    createdAt: squad.createdAt.toISOString(),
    updatedAt: squad.updatedAt.toISOString(),
  };
}
