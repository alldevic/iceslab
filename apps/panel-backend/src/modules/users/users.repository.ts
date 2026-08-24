import { prisma } from '../../prisma.js';
import type { User, UserTraffic, Prisma } from '../../generated/prisma/client.js';

export type UserWithTraffic = User & {
  traffic: UserTraffic | null;
  groupMembers: { groupId: string }[];
};

export type UserSort = 'username' | 'createdAt' | 'expireAt' | 'traffic';

export interface ListParams {
  page: number;
  limit: number;
  status?: string;
  groupId?: string;
  search?: string;
  tag?: string;
  /** R3 - filter by the per-user routing override. A preset id keeps only users
   *  pinned to it; `any` keeps everyone who has one; `none` keeps those who
   *  inherit. Without this the override is invisible in bulk: it lives in a
   *  collapsed Advanced block on one user's page, so nobody can answer "who did
   *  we pin, and why is that one person routed differently". */
  routingPreset?: string;
  /** Exact-match filters, as opposed to `search`'s fuzzy OR. Remnawave 3.x
   *  looks a user up by streaming the list with one of these pinned, and an
   *  approximate answer there would hand the shop the wrong account — so these
   *  are equality, never `contains`. */
  telegramId?: bigint;
  email?: string;
  sort?: UserSort;
  order?: 'asc' | 'desc';
}

/** Sentinels accepted by `routingPreset` alongside a concrete preset id. */
export const ROUTING_FILTER_ANY = 'any';
export const ROUTING_FILTER_NONE = 'none';

/**
 * Sortable columns, mapped to Prisma order clauses. Traffic lives on the
 * related row, hence the nested form. `nulls: 'last'` on expireAt keeps
 * never-expiring users at the bottom instead of leading the list.
 *
 * Every clause ends with `id` as a tiebreaker, because none of the sortable
 * columns is unique: most users share a traffic figure (0), expiry dates and
 * creation timestamps repeat (a bulk insert stamps one value on the whole
 * batch), and only `username` happens to be unique. Ordering a paginated read
 * by a non-unique key is not valid: each page is an independent LIMIT/OFFSET
 * query, and Postgres may break a tie differently per sort bound, so a tied row
 * can come back on two pages while its neighbour comes back on none. Measured
 * on 5000 users with one 8-row tie: 3 returned twice, 3 never returned. `id` is
 * the primary key, so appending it makes the total order strict and every page
 * exact.
 */
function orderClause(
  sort: UserSort,
  order: 'asc' | 'desc',
): Prisma.UserOrderByWithRelationInput[] {
  const tiebreaker: Prisma.UserOrderByWithRelationInput = { id: 'asc' };
  switch (sort) {
    case 'traffic':
      return [{ traffic: { usedTrafficBytes: order } }, tiebreaker];
    case 'expireAt':
      return [{ expireAt: { sort: order, nulls: 'last' } }, tiebreaker];
    case 'createdAt':
      return [{ createdAt: order }, tiebreaker];
    case 'username':
    default:
      return [{ username: order }, tiebreaker];
  }
}

export async function findActiveByUsername(username: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { username, deletedAt: null },
  });
}

export async function findBySubscriptionToken(
  token: string,
): Promise<{ id: string } | null> {
  // subscription_token is globally @unique (incl. soft-deleted rows), so this
  // catches an import clash against any existing user.
  return prisma.user.findUnique({
    where: { subscriptionToken: token },
    select: { id: true },
  });
}

export async function findActiveById(id: string): Promise<UserWithTraffic | null> {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: { traffic: true, groupMembers: { select: { groupId: true } } },
  });
}

/**
 * Resolve a user by their NUMERIC handle (Remnawave-compat). Separate from
 * findActiveById because the two identities are different columns and must not
 * be conflated: a decimal string is never a UUID, so a caller that has one has
 * unambiguously been given the numeric identity and must be answered from it.
 */
export async function findActiveByNumericId(
  numericId: bigint,
): Promise<UserWithTraffic | null> {
  return prisma.user.findFirst({
    where: { numericId, deletedAt: null },
    include: { traffic: true, groupMembers: { select: { groupId: true } } },
  });
}

export async function existsActive(id: string): Promise<boolean> {
  const count = await prisma.user.count({
    where: { id, deletedAt: null },
  });
  return count > 0;
}

export async function create(data: Prisma.UserCreateInput): Promise<UserWithTraffic> {
  return prisma.user.create({
    data,
    include: { traffic: true, groupMembers: { select: { groupId: true } } },
  });
}

export async function updateById(
  id: string,
  data: Prisma.UserUpdateInput,
): Promise<UserWithTraffic> {
  return prisma.user.update({
    where: { id },
    data,
    include: { traffic: true, groupMembers: { select: { groupId: true } } },
  });
}

export async function resetTraffic(userId: string): Promise<void> {
  // upsert (not update) so a legacy user missing its UserTraffic row still
  // resets cleanly instead of throwing P2025.
  await prisma.userTraffic.upsert({
    where: { userId },
    update: { usedTrafficBytes: 0n, lastTrafficResetAt: new Date() },
    create: { userId, usedTrafficBytes: 0n, lastTrafficResetAt: new Date() },
  });
}

export async function softDelete(id: string): Promise<void> {
  await prisma.user.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

export async function list(params: ListParams): Promise<{
  users: UserWithTraffic[];
  total: number;
}> {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(params.status ? { status: params.status } : {}),
    ...(params.groupId
      ? { groupMembers: { some: { groupId: params.groupId } } }
      : {}),
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.telegramId !== undefined ? { telegramId: params.telegramId } : {}),
    // Case-insensitive EQUALITY: addresses are compared case-folded by the
    // caller too, but the match itself must stay exact.
    ...(params.email !== undefined
      ? { email: { equals: params.email, mode: 'insensitive' as const } }
      : {}),
    ...(params.routingPreset === ROUTING_FILTER_ANY
      ? { routingPreset: { not: null } }
      : params.routingPreset === ROUTING_FILTER_NONE
        ? { routingPreset: null }
        : params.routingPreset
          ? { routingPreset: params.routingPreset }
          : {}),
    ...(params.search
      ? {
          OR: [
            { username: { contains: params.search, mode: 'insensitive' } },
            { email:    { contains: params.search, mode: 'insensitive' } },
            { tag:      { contains: params.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: { traffic: true, groupMembers: { select: { groupId: true } } },
      orderBy: orderClause(params.sort ?? 'username', params.order ?? 'asc'),
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total };
}