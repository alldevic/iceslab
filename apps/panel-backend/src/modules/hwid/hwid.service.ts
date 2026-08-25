import { prisma } from '../../prisma.js';
import { config } from '../../config.js';
import { emitRemnaWebhookForUser } from '../remnawave-compat/remnawave.webhook.js';

/**
 * Pick the effective ceiling on how many distinct device rows we're willing
 * to persist for one user. The per-user/squad `limit` is the admin's policy;
 * `systemMax` is an absolute backstop that applies even when there's no
 * per-user limit. Returns whichever is smaller (a null per-user limit means
 * "no policy limit", so the system backstop wins).
 *
 * Pure (no DB) so the ceiling decision is unit-testable without Postgres.
 */
export function effectiveDeviceCeiling(
  limit: number | null,
  systemMax: number,
): number {
  return limit === null ? systemMax : Math.min(limit, systemMax);
}

/**
 * Outcome of an HWID enforcement check on /sub/:token.
 *
 *   - `disabled`: neither header nor user limit set; no enforcement run.
 *   - `allowed`: device registered (upserted) and under quota.
 *   - `denied`: device count exceeds user's limit. Caller emits 403.
 */
export interface HwidCheckResult {
  status: 'disabled' | 'allowed' | 'denied';
  /** Total devices currently registered for this user (after upsert). */
  active: number;
  /** Configured per-user limit. NULL → unlimited. */
  limit: number | null;
}

/**
 * Validate the `x-hwid` header for this subscription request, register
 * the device if new, and decide whether to allow the response.
 *
 * Trust model: HWID is client-supplied, admins use this to deter casual
 * subscription sharing, not adversarial users. A user determined to share
 * can spoof the header; that's accepted as a non-goal.
 *
 * Behaviour:
 *   - hwid is null/empty → no enforcement, no row written.
 *   - user.hwidDeviceLimit is null → audit-only: a device row is recorded so
 *     admins can see it, but only up to an absolute system ceiling
 *     (`HWID_MAX_DEVICES_PER_USER`) so a client-controlled `x-hwid` can't grow
 *     the table without bound. At the ceiling the request still succeeds; we
 *     just stop recording new devices.
 *   - device already exists → bump `lastSeenAt`, return `allowed`.
 *   - new device + count would exceed the effective ceiling
 *     (min of per-user limit and the system max) → return `denied` WITHOUT
 *     inserting the row (so re-trying with the same headers produces the
 *     same result and admins see the device that bumped the count, not
 *     blocked attempts).
 *
 * The hwid string is bounded to 255 chars upstream by the route handler;
 * here we trust it. UTF-8 collation is fine for the equality check.
 */
/**
 * Client-reported device metadata (Remnawave-compat), captured from the
 * subscription-client headers on /sub. All optional/nullable — non-Remnawave
 * clients omit them.
 */
export interface HwidDeviceMeta {
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
}

/** Non-null metadata fields only, for a create/backfill `data` spread. */
function presentMeta(meta?: HwidDeviceMeta) {
  if (!meta) return {};
  return {
    ...(meta.platform ? { platform: meta.platform } : {}),
    ...(meta.osVersion ? { osVersion: meta.osVersion } : {}),
    ...(meta.deviceModel ? { deviceModel: meta.deviceModel } : {}),
    ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
  };
}

export async function enforceHwid(
  userId: string,
  hwid: string | null,
  limit: number | null,
  meta?: HwidDeviceMeta,
): Promise<HwidCheckResult> {
  if (!hwid) {
    // No header → no enforcement, no row. Return `active=0` for the
    // X-Hwid-Active header, clients display it as "0/N".
    return { status: 'disabled', active: 0, limit };
  }

  // A known device is always just a `lastSeenAt` touch, no new row, so it
  // can't grow the table regardless of any ceiling. Fast-path it (one indexed
  // update on the unique key) before any counting.
  const existing = await prisma.hwidUserDevice.findUnique({
    where: { userId_hwid: { userId, hwid } },
  });

  if (existing) {
    await prisma.hwidUserDevice.update({
      where: { id: existing.id },
      // Backfill metadata for rows created before this feature / by a header-less
      // first hit — only overwrite with a present (non-null) incoming value.
      data: { lastSeenAt: new Date(), ...presentMeta(meta) },
    });
    // For the unlimited (audit-only) path `active` stays cosmetic (0/unlimited);
    // otherwise report the real device count for the X-Hwid-Active gauge.
    const active = limit === null
      ? 0
      : await prisma.hwidUserDevice.count({ where: { userId } });
    return { status: 'allowed', active, limit };
  }

  // Brand-new device. Two concurrent /sub requests with different HWIDs could
  // both see `current < ceiling` and both insert, overshooting the cap by one.
  // Serialize per-user via a Postgres transaction-scoped advisory lock keyed on
  // a hash of userId; the lock auto-releases at tx end so unrelated users don't
  // block each other.
  //
  // The ceiling is `min(per-user limit, HWID_MAX_DEVICES_PER_USER)`. The system
  // backstop matters most on the `limit === null` path: `x-hwid` is a
  // client-controlled header with unbounded distinct values, so without a hard
  // cap one valid token could insert a never-pruned audit row per request until
  // the disk fills. Above the cap we skip the insert (audit-only for unlimited
  // users -> `allowed`; a real per-user limit -> `denied` so the client sees 403).
  const ceiling = effectiveDeviceCeiling(limit, config.HWID_MAX_DEVICES_PER_USER);
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    const current = await tx.hwidUserDevice.count({ where: { userId } });

    if (current >= ceiling) {
      // At the ceiling, DO NOT insert. A real per-user limit reports the
      // count and denies (403 upstream); the unlimited audit path just stops
      // growing the table and still lets the client through.
      if (limit === null) {
        return { result: { status: 'allowed' as const, active: 0, limit: null }, created: null };
      }
      return { result: { status: 'denied' as const, active: current, limit }, created: null };
    }

    const created = await tx.hwidUserDevice.create({
      data: { userId, hwid, ...presentMeta(meta) },
    });
    return {
      result: {
        status: 'allowed' as const,
        active: limit === null ? 0 : current + 1,
        limit,
      },
      created,
    };
  });

  // Remnawave emits `user_hwid_devices.added` when a device row is created, and
  // a minishop that knows the event tells the user a new device appeared -
  // offering a device top-up when they are at their limit. Emitted only on a
  // genuine insert: the `existing` fast path above is a lastSeenAt touch, and
  // announcing "new device" on every request from a device the user has always
  // had is worse than saying nothing.
  //
  // AFTER the transaction, deliberately. The insert runs while a per-user
  // advisory lock is held, and that lock lives until the transaction ends, so a
  // POST to the shop from inside it would hold up every other device check for
  // that user for the length of an HTTP round trip to a third party.
  //
  // Fire-and-forget through the shared emitter, which no-ops when the facade is
  // off, resolves the user inside the send semaphore, and never throws: this is
  // a notification, and a device must still be admitted when the shop is down.
  if (outcome.created) {
    emitRemnaWebhookForUser(
      'user_hwid_devices.added',
      userId,
      {},
      {
        // The key Remnawave itself uses (`data: { user, hwidUserDevice }`), and
        // one of the three the shop looks for. `userAgent` and `requestIp` are
        // on the row and deliberately not sent - the shop's own extractor drops
        // them as unsafe, so shipping them would only widen where they travel.
        hwidUserDevice: {
          hwid: outcome.created.hwid,
          platform: outcome.created.platform,
          osVersion: outcome.created.osVersion,
          deviceModel: outcome.created.deviceModel,
          // Our column is `firstSeenAt`; Remnawave's entity calls it `createdAt`,
          // and the name is load-bearing rather than cosmetic. The shop hashes
          // `hwid + createdAt` into its dedupe fingerprint precisely so that a
          // device removed and later reconnected - same HWID, new row - reads as
          // a new event instead of a duplicate delivery to swallow. Sent under
          // the wrong name it would be absent, every event for one HWID would
          // share a fingerprint, and the second connection would go unannounced.
          createdAt: outcome.created.firstSeenAt.toISOString(),
        },
      },
    );
  }
  return outcome.result;
}

/**
 * K7 - reduce a user's per-squad HWID device-limit defaults to one effective
 * default. The MAX across the squads' positive values wins (most-permissive
 * cohort grants the device count); null when no squad sets one. Used only when
 * the user has no explicit hwidDeviceLimit. Pure (no DB) for testing.
 */
export function resolveSquadHwidLimit(squadDefaults: (number | null)[]): number | null {
  const vals = squadDefaults.filter((n): n is number => typeof n === 'number' && n > 0);
  return vals.length > 0 ? Math.max(...vals) : null;
}

/**
 * Admin-facing: list all devices currently registered for a user. Sorted
 * newest-first so the recently-added entry sits on top of the UI list.
 */
export async function listUserDevices(userId: string) {
  return prisma.hwidUserDevice.findMany({
    where: { userId },
    orderBy: [{ lastSeenAt: 'desc' }],
  });
}

/**
 * Admin-facing: revoke (delete) a single device row so the user can
 * register a different physical device on the next /sub/:token hit.
 */
export async function deleteDevice(id: string): Promise<void> {
  await prisma.hwidUserDevice.delete({ where: { id } });
}
