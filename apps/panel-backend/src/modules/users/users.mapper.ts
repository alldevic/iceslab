import type { GroupMember, User, UserTraffic } from '../../generated/prisma/client.js';

/**
 * Public DTO returned to admins via REST API.
 * Strips all protocol credentials and internal lifecycle fields.
 */
export interface PublicUserDto {
  id: string;
  shortId: string;
  username: string;
  status: string;

  // Subscription window
  expireAt: string | null;          // ISO 8601 string

  // Traffic
  trafficLimitBytes: number | null;     // null = unlimited
  trafficUsedBytes: number;
  lifetimeTrafficBytes: number;
  trafficLimitStrategy: string;
  lastTrafficResetAt: string | null;
  /** When the user last connected (touched any node). null = never online. */
  lastOnlineAt: string | null;

  // Subscription URL
  subscriptionToken: string;
  subRevokedAt: string | null;

  // Limits
  hwidDeviceLimit: number | null;

  // R3 - per-user routing-preset override; null = inherit (squad -> global -> default).
  routingPreset: string | null;

  // Metadata
  description: string | null;
  tag: string | null;
  telegramId: string | null;        // BigInt → string
  email: string | null;
  // Remnawave-compat: the user's stable NUMERIC handle (BigInt → string, like
  // telegramId). Present natively because it is a real property of the row, not
  // a facade invention — the facade is only the first thing that needed it.
  numericId: string;
  // Remnawave-compat: opaque external-squad id, echoed verbatim (passthrough).
  externalSquadUuid: string | null;

  // Per-user enabled protocols (subset of {hysteria,xray,amneziawg,naive})
  enabledProtocols: string[];

  // Squad membership (slice 26)
  groupIds: string[];

  // Lifecycle
  createdAt: string;
  updatedAt: string;
}

/**
 * Convert Prisma User (+ optional UserTraffic) into the public-safe DTO.
 *
 * Rules:
 *   - Never include: hysteriaPassword, naivePassword, xrayUuid,
 *     amneziawgPrivateKey, amneziawgPublicKey, deletedAt
 *   - BigInt → number (safe up to 9 PB, our quotas are way below)
 *   - BigInt telegramId → string (full precision preserved)
 *   - Date → ISO string
 */
export function mapUserToPublic(
  user: User & { groupMembers?: Pick<GroupMember, 'groupId'>[] },
  traffic: UserTraffic | null,
): PublicUserDto {
  return {
    id: user.id,
    shortId: user.shortId,
    username: user.username,
    status: user.status,

    expireAt: user.expireAt ? user.expireAt.toISOString() : null,

    trafficLimitBytes: user.trafficLimitBytes !== null
      ? Number(user.trafficLimitBytes)
      : null,
    trafficUsedBytes: traffic ? Number(traffic.usedTrafficBytes) : 0,
    lifetimeTrafficBytes: traffic ? Number(traffic.lifetimeTrafficBytes) : 0,
    trafficLimitStrategy: user.trafficLimitStrategy,
    lastTrafficResetAt: traffic?.lastTrafficResetAt
      ? traffic.lastTrafficResetAt.toISOString()
      : null,
    lastOnlineAt: traffic?.onlineAt ? traffic.onlineAt.toISOString() : null,

    subscriptionToken: user.subscriptionToken,
    subRevokedAt: user.subRevokedAt ? user.subRevokedAt.toISOString() : null,

    hwidDeviceLimit: user.hwidDeviceLimit,

    routingPreset: user.routingPreset,

    description: user.description,
    tag: user.tag,
    telegramId: user.telegramId !== null ? user.telegramId.toString() : null,
    email: user.email,
    numericId: user.numericId.toString(),
    externalSquadUuid: user.externalSquadUuid,

    enabledProtocols: parseEnabledProtocols(user.enabledProtocols),

    groupIds: user.groupMembers?.map((m) => m.groupId) ?? [],

    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * Prisma `Json` field returns `unknown`, narrow to a string[] of valid
 * protocol names. Falls back to ['hysteria'] if the stored shape is
 * unexpected (defensive, should not happen with our schema validation).
 */
export function parseEnabledProtocols(value: unknown): string[] {
  if (!Array.isArray(value)) return ['hysteria'];
  return value.filter((v): v is string => typeof v === 'string');
}