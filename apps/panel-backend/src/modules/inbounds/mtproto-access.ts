import { prisma } from '../../prisma.js';

/**
 * Who a node may serve MTProto to.
 *
 * Every other per-user credential the panel pushes is inert on an adapter that
 * has no use for it, which is why they are all sent unconditionally. The MTProto
 * secret stopped being that on the day the mtprotoproxy engine arrived: the
 * adapter writes exactly what it receives into `USERS`, so a secret that reaches
 * the node IS an account on that proxy. Sending everyone's meant the inbound
 * served everyone the node had ever heard of, whatever squad they were in —
 * measured 2026-09-02, all five live buyers in the `USERS` of a test inbound
 * nobody had been given.
 *
 * Which made a squad a rule about who gets the LINK, not about who gets in. The
 * only thing keeping a stranger out was not knowing the port.
 *
 * The entitlement is the ordinary one, the same shape the subscription resolves:
 * a squad grants profiles, a profile is bound to nodes. A person may be served
 * MTProto by a node when some squad of theirs grants an mtproto profile that is
 * bound to it, both ends enabled.
 *
 * Two directions of one question, because the two push paths ask it differently:
 * the inbound sync holds a node and needs its people, the per-user queue holds a
 * person and needs their nodes.
 */

/** Enabled mtproto profiles this node actually carries. */
async function mtprotoProfileIdsOnNode(nodeId: string): Promise<string[]> {
  const rows = await prisma.profileNodeBinding.findMany({
    where: {
      nodeId,
      enabled: true,
      // Engine is deliberately not part of the question. On mtg the secret is
      // ignored (it has no user concept), so narrowing to mtprotoproxy would buy
      // nothing and would silently change who is entitled the day an operator
      // switches the engine on an existing profile.
      profile: { enabled: true, protocol: 'mtproto' },
    },
    select: { profileId: true },
  });
  return [...new Set(rows.map((r) => r.profileId))];
}

/**
 * Ids of the users this node may serve MTProto to. EMPTY when the node carries
 * no mtproto inbound at all, which is the common case and costs one query.
 */
export async function mtprotoUsersForNode(nodeId: string): Promise<Set<string>> {
  const profileIds = await mtprotoProfileIdsOnNode(nodeId);
  if (profileIds.length === 0) return new Set();
  const rows = await prisma.groupMember.findMany({
    where: { group: { groupProfiles: { some: { profileId: { in: profileIds } } } } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/** Ids of the nodes that may serve this user MTProto. */
export async function mtprotoNodesForUser(userId: string): Promise<Set<string>> {
  const rows = await prisma.profileNodeBinding.findMany({
    where: {
      enabled: true,
      profile: {
        enabled: true,
        protocol: 'mtproto',
        groupProfiles: { some: { group: { members: { some: { userId } } } } },
      },
      node: { deletedAt: null, status: { not: 'disabled' } },
    },
    select: { nodeId: true },
  });
  return new Set(rows.map((r) => r.nodeId));
}
