import { prisma } from '../../prisma.js';
import { SUBSCRIPTION_REQUEST_RETENTION_DAYS } from '../maintenance/retention.cron.js';

/**
 * Who is still holding the old link.
 *
 * Editing a host, or the binding or profile under it, changes the URL a client
 * already has. Nothing breaks at that moment: the subscriber keeps connecting
 * on the old config until it stops authenticating, and then finds out on their
 * own, which is the failure this screen exists to get ahead of.
 *
 * One stamp column per row (link_changed_at, A-122), nothing more. The panel already writes a row per `/sub` poll
 * (SubscriptionRequestHistory), so "has this person re-read since the change"
 * is a question the existing data answers, and a monotonic v3/v4 number on the
 * host would add nothing the timestamps do not already say.
 */

/**
 * When the link behind this host last changed.
 *
 * A host is a set of overrides on top of `binding + profile + node`, so the
 * rows under it are part of its link: moving the port is an edit to the
 * BINDING and it changes the link every client holds without touching the host
 * row. Same shape as the node's `configChangedAt`, for the same reason - the
 * unit of editing and the unit of config are different things.
 *
 * A-122: by each row's `linkChangedAt`, not `updatedAt`. updatedAt moves on
 * any write: dragging hosts rewrites every host's priority, renaming a profile
 * changes nothing a client holds, and after either this card said every
 * subscriber held the old link. The stamp moves only when a value that goes
 * into the link really changes; the fields are listed below, and each write
 * compares the new value with the stored one (sameValue).
 */
export function hostConfigChangedAt(parts: {
  host: Date;
  binding: Date;
  profile: Date;
  node: Date;
}): Date {
  return [parts.binding, parts.profile, parts.node].reduce(
    (latest, d) => (d > latest ? d : latest),
    parts.host,
  );
}

/** Host fields that reach the client: all but `priority` (the order in the
 *  panel's list). `remark` is the line's name in the client. */
export const HOST_LINK_FIELDS = [
  'remark', 'enabled', 'addressOverride', 'portOverride', 'sniOverride', 'hostHeaderOverride',
  'pathOverride', 'fingerprintOverride', 'alpn', 'allowInsecure', 'securityLayer',
  'disableForFormats', 'serverDescription', 'isHidden',
] as const;

/** Binding fields that reach the client: all of them. */
export const BINDING_LINK_FIELDS = ['port', 'publicHost', 'publicPort', 'overrides', 'transport', 'enabled'] as const;

/** Profile fields that reach the client; `name` and `description` do not. */
export const PROFILE_LINK_FIELDS = ['config', 'engine', 'awgProtocol', 'enabled'] as const;

/** Node fields that reach the client and are edited on the node: the address
 *  and the self-steal SNI. The hysteria pin and the AmneziaWG 3.1 geometry
 *  are written at push time and stamp there (hysteria-tls.ts,
 *  awg3-geometry.ts). `name` and `countryCode` are only in the label. */
export const NODE_LINK_FIELDS = ['address', 'domain'] as const;

export interface HostFreshnessDto {
  configChangedAt: string;
  /** Subscribers who fetched the subscription after that moment: their client
   *  holds the current link. */
  current: number;
  /** Subscribers who have not. Their config is the old one. */
  stale: number;
  total: number;
  /** Subset of `stale` with no request on record at all: either they never
   *  fetched, or their last fetch fell out of the retention window below. Split
   *  out because the two read differently on screen - "never installed it" is a
   *  sales problem, "has not opened the app in three months" is not. */
  neverFetched: number;
  /** How far back the evidence goes. Beyond this the history is pruned, so a
   *  quiet subscriber counts as stale. For this screen that is the RIGHT
   *  answer rather than a rounding error: someone who has not polled in that
   *  long is certainly still on the old link. */
  retentionDays: number;
}

export async function getHostFreshness(hostId: string): Promise<HostFreshnessDto | null> {
  const host = await prisma.host.findUnique({
    where: { id: hostId },
    select: {
      linkChangedAt: true,
      binding: {
        select: {
          linkChangedAt: true,
          profile: { select: { linkChangedAt: true } },
          node: { select: { linkChangedAt: true } },
        },
      },
    },
  });
  if (!host) return null;

  const changedAt = hostConfigChangedAt({
    host: host.linkChangedAt,
    binding: host.binding.linkChangedAt,
    profile: host.binding.profile.linkChangedAt,
    node: host.binding.node.linkChangedAt,
  });

  // The audience is the same join `reachByHost` uses, including the squad
  // narrowing rule (no GroupHost rows for a squad = it hands out every host of
  // its profiles; any rows = exactly those). Counting people rather than
  // memberships matters here as much as it does there: one person in two squads
  // is one person who cannot connect.
  //
  // Strictly `>`, the same boundary as isConfigApplied and for the same reason:
  // a poll in the same millisecond as the save carries the config from BEFORE
  // it, so equal has to count as stale. Erring the other way would report a
  // subscriber as safe while their client holds a link that no longer works.
  const [row] = await prisma.$queryRaw<
    { total: number; current: number; never_fetched: number }[]
  >`
    SELECT COUNT(DISTINCT u.id)::int AS total,
           COUNT(DISTINCT u.id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM subscription_request_history r
               WHERE r.user_id = u.id AND r.requested_at > ${changedAt}
             )
           )::int AS current,
           COUNT(DISTINCT u.id) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM subscription_request_history r2 WHERE r2.user_id = u.id
             )
           )::int AS never_fetched
    FROM hosts h
    JOIN profile_node_bindings b ON b.id = h.binding_id
    JOIN group_profiles gp       ON gp.profile_id = b.profile_id
    JOIN group_members gm        ON gm.group_id = gp.group_id
    JOIN users u                 ON u.id = gm.user_id AND u.deleted_at IS NULL
                                 -- A-122: a disabled, expired or limited user
                                 -- has no use for the link either way.
                                 AND u.status = 'active'
    WHERE h.id = ${hostId}::uuid
      AND (
        NOT EXISTS (SELECT 1 FROM group_hosts x WHERE x.group_id = gp.group_id)
        OR EXISTS (SELECT 1 FROM group_hosts y
                   WHERE y.group_id = gp.group_id AND y.host_id = h.id)
      )
  `;

  const total = row?.total ?? 0;
  const current = row?.current ?? 0;
  return {
    configChangedAt: changedAt.toISOString(),
    current,
    stale: total - current,
    total,
    neverFetched: row?.never_fetched ?? 0,
    retentionDays: SUBSCRIPTION_REQUEST_RETENTION_DAYS,
  };
}
