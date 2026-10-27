import { prisma } from '../../prisma.js';
import { deadCascadeIds } from '../cascades/cascade-exclusive.js';

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
 *     the subscription emits nothing for it;
 *   - and when that squad has not switched off a cascade entered through this
 *     very inbound (entriesSwitchedOff, A-116).
 *
 * Liveness (unreachable) is left out on purpose: the subscription drops a node
 * that has been unreachable for a while, but the user must still be on it when
 * it answers again.
 *
 * Answer: userId -> nodeId -> binding ids (InboundDto.id). A user absent from
 * the map, or a node absent under a user, is reached nowhere / not there.
 */
export type UserReach = Map<string, Map<string, string[]>>;

/**
 * A-116: the cascade entries a squad switched off where the entry cannot keep
 * the switch. Per squad, keys `${nodeId}|${protocol}`.
 *
 * A cascade entered through hysteria or AmneziaWG sends everything its inbound
 * takes into the chain: there is no per-user rule on the node to leave a squad
 * out (A-134 refuses narrowing there for the same reason). So "off" for a squad
 * means its members do not reach that inbound at all: they are not put on it,
 * and the subscription does not hand its host out. A member of another squad
 * that did not switch the cascade off still reaches it, the union of squads
 * does that as everywhere else. An xray entry keeps the switch in its routing
 * (cascadeIsOffAt), and is not listed here.
 */
export async function entriesSwitchedOff(groupIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (groupIds.length === 0) return out;
  const rows = await prisma.groupCascadeOff.findMany({
    where: {
      groupId: { in: groupIds },
      cascade: {
        enabled: true,
        // A-223: a dead cascade does not chain its entry, so switching it off
        // takes nothing away: its inbound is a plain one.
        id: { notIn: [...(await deadCascadeIds())] },
        positions: { some: { position: 0, entryProtocol: { in: ['hysteria', 'amneziawg'] } } },
      },
    },
    select: {
      groupId: true,
      cascade: {
        select: {
          positions: { where: { position: 0 }, select: { entryProtocol: true, nodes: { select: { nodeId: true } } } },
        },
      },
    },
  });
  for (const r of rows) {
    const keys = out.get(r.groupId) ?? out.set(r.groupId, new Set()).get(r.groupId)!;
    for (const p of r.cascade.positions) {
      for (const n of p.nodes) keys.add(`${n.nodeId}|${p.entryProtocol}`);
    }
  }
  return out;
}

/** Per squad, the bindings it reaches (the rule above), on one node or all. */
export async function bindingsReachedBySquads(
  groupIds: string[],
  opts: { nodeId?: string } = {},
): Promise<Map<string, { id: string; nodeId: string }[]>> {
  const reachedBy = new Map<string, { id: string; nodeId: string }[]>();
  if (groupIds.length === 0) return reachedBy;
  const [grants, hostGrants, bindings, switchedOff] = await Promise.all([
    prisma.groupProfile.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, profileId: true } }),
    prisma.groupHost.findMany({ where: { groupId: { in: groupIds } }, select: { groupId: true, hostId: true } }),
    prisma.profileNodeBinding.findMany({
      where: {
        enabled: true,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        profile: { enabled: true, groupProfiles: { some: { groupId: { in: groupIds } } } },
        node: { deletedAt: null, status: { not: 'disabled' } },
      },
      select: {
        id: true,
        nodeId: true,
        profileId: true,
        profile: { select: { protocol: true } },
        hosts: { where: { enabled: true }, select: { id: true } },
      },
    }),
    entriesSwitchedOff(groupIds),
  ]);

  const profilesOf = new Map<string, Set<string>>();
  for (const g of grants) (profilesOf.get(g.groupId) ?? profilesOf.set(g.groupId, new Set()).get(g.groupId)!).add(g.profileId);
  const hostsOf = new Map<string, Set<string>>();
  for (const h of hostGrants) (hostsOf.get(h.groupId) ?? hostsOf.set(h.groupId, new Set()).get(h.groupId)!).add(h.hostId);

  for (const g of groupIds) {
    const profiles = profilesOf.get(g);
    if (!profiles) continue;
    const narrowed = hostsOf.get(g);
    const off = switchedOff.get(g);
    reachedBy.set(
      g,
      bindings
        .filter(
          (b) =>
            profiles.has(b.profileId) &&
            b.hosts.length > 0 &&
            (!narrowed || b.hosts.some((h) => narrowed.has(h.id))) &&
            !off?.has(`${b.nodeId}|${b.profile.protocol}`),
        )
        .map((b) => ({ id: b.id, nodeId: b.nodeId })),
    );
  }
  return reachedBy;
}

/**
 * `userIds` null = every active user. Passed as a filter rather than a list on
 * the paths that cover the whole roster (the push, the entry gate): a list of
 * 30 000 ids is past Postgres's 32 767 bind parameters once the query adds its
 * own.
 */
export async function reachOfUsers(userIds: string[] | null, opts: { nodeId?: string } = {}): Promise<UserReach> {
  const out: UserReach = new Map();
  if (userIds !== null && userIds.length === 0) return out;

  const memberships = await prisma.groupMember.findMany({
    where:
      userIds === null
        ? { user: { deletedAt: null, status: 'active' } }
        : { userId: { in: userIds } },
    select: { userId: true, groupId: true },
  });
  const reachedBy = await bindingsReachedBySquads([...new Set(memberships.map((m) => m.groupId))], opts);
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