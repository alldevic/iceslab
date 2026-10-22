import { prisma } from '../../prisma.js';

/**
 * A-022: which inbounds of which nodes a user is served on, from their squads.
 *
 * The same rule the subscription hands out endpoints by (subscription.service,
 * the binding query and the host narrowing after it), so a user is put on a
 * node exactly where their subscription sends them:
 *   - a binding counts when it is enabled, its profile is enabled and granted
 *     by one of the user's squads, and its node is live (not deleted, not
 *     disabled);
 *   - and when it has an enabled host that squad reaches: a squad with no host
 *     rows reaches every host of its profiles (the opt-in narrowing), one with
 *     host rows only those hosts. A binding with no enabled host serves nobody,
 *     the subscription emits nothing for it.
 *
 * Liveness (unreachable) is left out on purpose: the subscription drops a node
 * that has been unreachable for a while, but the user must still be on it when
 * it answers again.
 *
 * Answer: userId -> nodeId -> binding ids (InboundDto.id). A user absent from
 * the map, or a node absent under a user, is reached nowhere / not there.
 */
export type UserReach = Map<string, Map<string, string[]>>;

export async function reachOfUsers(userIds: string[], opts: { nodeId?: string } = {}): Promise<UserReach> {
  const out: UserReach = new Map();
  if (userIds.length === 0) return out;

  const memberships = await prisma.groupMember.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, groupId: true },
  });
  const groupIds = [...new Set(memberships.map((m) => m.groupId))];
  if (groupIds.length === 0) return out;

  const [grants, hostGrants, bindings] = await Promise.all([
    prisma.groupProfile.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, profileId: true } }),
    prisma.groupHost.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, hostId: true } }),
    prisma.profileNodeBinding.findMany({
      where: {
        enabled: true,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        profile: { enabled: true, groupProfiles: { some: { groupId: { in: groupIds } } } },
        node: { deletedAt: null, status: { not: 'disabled' } },
      },
      select: { id: true, nodeId: true, profileId: true, hosts: { where: { enabled: true }, select: { id: true } } },
    }),
  ]);

  const profilesOf = new Map<string, Set<string>>();
  for (const g of grants) (profilesOf.get(g.groupId) ?? profilesOf.set(g.groupId, new Set()).get(g.groupId)!).add(g.profileId);
  const hostsOf = new Map<string, Set<string>>();
  for (const h of hostGrants) (hostsOf.get(h.groupId) ?? hostsOf.set(h.groupId, new Set()).get(h.groupId)!).add(h.hostId);

  // Per squad, the bindings it reaches: computed once per squad, not per user.
  const reachedBy = new Map<string, typeof bindings>();
  for (const g of groupIds) {
    const profiles = profilesOf.get(g);
    if (!profiles) continue;
    const narrowed = hostsOf.get(g);
    reachedBy.set(
      g,
      bindings.filter(
        (b) =>
          profiles.has(b.profileId) &&
          b.hosts.length > 0 &&
          (!narrowed || b.hosts.some((h) => narrowed.has(h.id))),
      ),
    );
  }

  for (const m of memberships) {
    for (const b of reachedBy.get(m.groupId) ?? []) {
      const byNode = out.get(m.userId) ?? out.set(m.userId, new Map()).get(m.userId)!;
      const list = byNode.get(b.nodeId) ?? byNode.set(b.nodeId, []).get(b.nodeId)!;
      if (!list.includes(b.id)) list.push(b.id);
    }
  }
  for (const byNode of out.values()) for (const list of byNode.values()) list.sort();
  return out;
}
