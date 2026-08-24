import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, subscriptionOrigin } from '../../config.js';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/redis.js';
import { requireAuth } from '../auth/auth.hook.js';
import * as usersService from '../users/users.service.js';
import { CreateUserSchema, UpdateUserSchema } from '../users/users.schemas.js';
import { mapUserToPublic } from '../users/users.mapper.js';
import * as squadsService from '../squads/squads.service.js';
import * as hwidService from '../hwid/hwid.service.js';
import { getOverview } from '../dashboard/dashboard.service.js';
import { formatBytes } from '../settings/settings.service.js';
import { inboundSyncQueue, inboundDirtyKey } from '../inbounds/inbounds.queue.js';
import { ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID, NO_ACCESS_SQUAD_NAME } from '../squads/squads.constants.js';
import {
  mapUserToRemna,
  bytesToNativeLimit,
  hwidLimitToNative,
  strategyToNative,
  statusToNative,
  type RemnaMapCtx,
} from './remnawave.mappers.js';
import { RemnaError, sendResponse, remnawaveErrorHandler } from './remnawave.http.js';
import { parseUserRef, resolveUserId, resolveUserRef } from './remnawave.identity.js';
import { NodeTransport } from '../nodes/nodes.transport.js';
import { nodeUsersQueue, buildAddUserRequest } from '../users/users.queue.js';
import { getLogger } from '../../lib/logger.js';

// Same include the users repository uses, so mapUserToPublic sees traffic +
// group membership for the facade's direct lookups (by-telegram-id/email/username).
const USER_INCLUDE = {
  traffic: true,
  groupMembers: { select: { groupId: true } },
} as const;

/**
 * The Remnawave API version this facade claims at GET /system/metadata.
 *
 * Its MAJOR is the load-bearing part: the client derives the user-identity model
 * and the whole route set from it, so changing this to a 2.x string silently
 * re-points every user-scoped call at an identity this facade no longer emits.
 * The exact value is the client's certified preset for the 3.x generation, which
 * keeps us on its tested matrix instead of in best-effort mode.
 */
const REMNAWAVE_API_VERSION = '3.3.2';

/** A telegram id from a stream filter, or null when it is not one. Separate from
 *  parseUserRef despite the similar shape: a telegram id is Telegram's number,
 *  not ours, and tying the two together would silently couple our identity
 *  bounds to theirs. */
function parseTelegramId(raw: string): bigint | null {
  return /^[0-9]{1,19}$/.test(raw) ? BigInt(raw) : null;
}

/** A telegramId no row can hold, for a filter that failed to parse — see the
 *  stream route for why an unparseable filter must match nothing rather than
 *  fall away. */
const NO_SUCH_ID = -1n;

// "Online now" window — the same 3 min the dashboard uses, so the facade's
// per-node counts agree with the panel's global "online now".
const ONLINE_NOW_WINDOW_MS = 3 * 60 * 1000;

// HWID device row → Remnawave device shape. `createdAt` maps from `firstSeenAt`
// (there is no native `createdAt` column on hwid_user_devices).
function mapDevice(d: {
  id: string;
  hwid: string;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
  firstSeenAt: Date;
}) {
  return {
    id: d.id,
    hwid: d.hwid,
    platform: d.platform,
    osVersion: d.osVersion,
    deviceModel: d.deviceModel,
    userAgent: d.userAgent,
    createdAt: d.firstSeenAt.toISOString(),
  };
}

// Parse a caller's calendar-date query param (YYYY-MM-DD) to a UTC midnight
// Date, falling back to `dflt` when absent OR malformed. The shop only ever
// sends bare YYYY-MM-DD, but without this guard any other shape yields an
// Invalid Date that Prisma rejects at where-clause serialization (RangeError ->
// unhandled 500) instead of a clean result.
function parseUtcDay(s: string | undefined, dflt: Date): Date {
  if (!s) return dflt;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? dflt : d;
}

// UTC calendar-date range [start 00:00, end+1day) for the byte-history queries;
// defaults to the last 30 days when the caller omits them.
function dateRangeExclusiveEnd(start?: string, end?: string): { startTs: Date; endTs: Date } {
  const nowMs = Date.now();
  const startTs = parseUtcDay(start, new Date(nowMs - 30 * 86_400_000));
  const endBase = parseUtcDay(end, new Date(nowMs));
  const endTs = new Date(endBase);
  endTs.setUTCDate(endTs.getUTCDate() + 1); // inclusive end day
  return { startTs, endTs };
}

// ───── Remnawave request bodies (permissive — minishop is the only client) ─────

const RemnaCreateSchema = z
  .object({
    username: z.string(),
    status: z.string().optional(),
    expireAt: z.string().nullish(),
    trafficLimitBytes: z.number().nullish(),
    trafficLimitStrategy: z.string().optional(),
    hwidDeviceLimit: z.number().int().nullish(),
    activeInternalSquads: z.array(z.string()).optional(),
    externalSquadUuid: z.string().nullish(),
    telegramId: z.union([z.number(), z.string()]).nullish(),
    email: z.string().nullish(),
    description: z.string().nullish(),
    tag: z.string().nullish(),
  })
  .loose();

// Update is a PARTIAL patch. The minishop's update_user_details_on_panel builds
// the body from _build_panel_update_payload, which emits ONLY the changed fields
// + uuid and NEVER username. Inheriting the create schema's required `username`
// therefore 400'd every real update (activation/extension/topup/traffic-package/
// trial/squad-sync) → the shop read None → it rolled back the paid activation.
// uuid is required; username (and everything else) is optional here.
// The 3.x selector is the integer `id`; the client pops `uuid` and sets `id`
// once it has detected a numeric-identity panel. `uuid` is still accepted so a
// 2.x-shaped body (a stale in-flight request during a restart, or a hand-made
// call) is answered rather than 400'd — resolveUserRef rejects it as "no such
// user" if it is not in fact a numeric reference.
const RemnaUpdateSchema = RemnaCreateSchema.extend({
  id: z.union([z.number().int(), z.string()]).optional(),
  uuid: z.string().optional(),
  username: z.string().optional(),
}).refine((b) => b.id !== undefined || b.uuid !== undefined, {
  message: 'update needs a user selector (id)',
});

// Bulk squad membership. The 3.x selector is `userIds` (numeric); the cap
// matches the client's own chunk size, and exists so one request can't fan out
// into an unbounded number of per-user DB writes (each id = a lookup + update).
const BulkUsersSchema = z
  .object({
    userIds: z.array(z.union([z.number().int(), z.string()])).max(1000).optional(),
  })
  .loose();

/** Body of POST /connections/drop. `dropBy.by` names the selector the client
 *  used; we read whichever array is present rather than branching on it, because
 *  the client already guarantees one selector per chunk. */
const DropConnectionsSchema = z
  .object({
    dropBy: z
      .object({
        by: z.string().optional(),
        userIds: z.array(z.union([z.number().int(), z.string()])).max(1000).optional(),
        userUuids: z.array(z.string()).max(1000).optional(),
      })
      .loose()
      .optional(),
    targetNodes: z
      .object({
        target: z.string().optional(),
        nodeUuids: z.array(z.string()).max(1000).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** Body of POST /users/bulk/update-squads. The client picks ONE selector for the
 *  whole chunk - numeric `userIds` under rw3, `uuids` under rw2 - and refuses to
 *  send a mixed batch itself, so accepting either and preferring userIds matches
 *  what it actually does. */
const BulkUpdateSquadsSchema = z
  .object({
    userIds: z.array(z.union([z.number().int(), z.string()])).max(1000).optional(),
    uuids: z.array(z.string()).max(1000).optional(),
    activeInternalSquads: z.array(z.string()).default([]),
  })
  .loose();

/** Body of the multi-node bandwidth routes. `.loose()` for the same reason
 *  BulkUsersSchema is: the shop may add fields and a strict parse would 400 a
 *  call that is otherwise fine. */
const NodesUuidsSchema = z
  .object({ nodesUuids: z.array(z.string()).max(1000).optional() })
  .loose();

export async function remnawaveCompatRoutes(app: FastifyInstance): Promise<void> {
  // Facade-scoped error handler → Remnawave {errorCode,message} shape. Because
  // this plugin is registered as an encapsulated child, it overrides the root
  // handler only for facade routes.
  app.setErrorHandler(remnawaveErrorHandler);

  // Every authenticated facade route: auth via the native icp_ bearer hook, plus
  // a generous (not disabled) rate limit — this is a trusted server-to-server
  // integration that bursts during user sync, but an uncapped surface would let
  // a leaked token amplify writes/probes without bound.
  const opts = {
    onRequest: [requireAuth],
    config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
  };

  // ───── group helpers ─────

  // Ensure the system-managed no-access squad row exists (idempotent, by
  // constant id). squads.service protects it from edit/delete, so a stale-cache
  // or admin-delete → full-access-escalation hazard can't arise; called only
  // when an empty squad set must be materialized.
  async function ensureNoAccessGroup(): Promise<void> {
    await prisma.group.upsert({
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

  // Squad id → display name, plus the two system groups (ALL + no-access) to
  // hide from activeInternalSquads so the minishop doesn't capture them as
  // phantom overrides. Both ids are constants — no DB lookup for the hidden set.
  async function mapCtx(): Promise<RemnaMapCtx> {
    const squads = await squadsService.listSquads();
    return {
      squadNames: new Map(squads.map((s) => [s.id, s.name])),
      hiddenGroupIds: new Set<string>([ALL_SQUAD_ID, NO_ACCESS_SQUAD_ID]),
    };
  }

  // An empty Remnawave squad set means "no access" — map it to the no-access
  // group so native doesn't promote the user to the "All" squad (full access).
  //
  // Normalisation is load-bearing, not cosmetic. Postgres `uuid` is
  // case-insensitive and stores lowercase, so ['X','x'] and ['X','X'] both
  // become the SAME group_members row → composite-PK violation (P2002). That
  // surfaced as a deterministic 500 on PATCH and — because createUser blanket-
  // mapped P2002 to "username exists" — a bogus 409 A019 on create for a user
  // that did not exist, dead-ending a paid activation. Lowercase + dedupe first.
  //
  // The two system groups are rejected outright: they are hidden from
  // /internal-squads and stripped from activeInternalSquads on read, so
  // accepting one would persist a membership the echo can never show — the shop
  // compares the set it sent against the echo and rolls back the paid activation
  // on mismatch. A loud 400 is diagnosable; a silent mismatch loop is not.
  function normalizeSquadIds(squads: string[]): string[] {
    const ids = [...new Set(squads.map((s) => s.trim().toLowerCase()))];
    for (const id of ids) {
      if (id === ALL_SQUAD_ID || id === NO_ACCESS_SQUAD_ID) {
        throw new RemnaError(
          400,
          'VALIDATION_ERROR',
          'system squad cannot be assigned; use a real squad or an empty list',
        );
      }
    }
    return ids;
  }

  // Shop-supplied squad sets (create / PATCH): validate + normalise.
  async function resolveGroupIds(squads: string[]): Promise<string[]> {
    return withNoAccessFallback(normalizeSquadIds(squads));
  }

  // Internal, DB-derived squad sets (the bulk routes): these legitimately carry
  // whatever the row already had — including the system groups a native default
  // put there — so they must NOT be validated, only backstopped. An empty set
  // becomes the no-access group, never native's "All" (full access).
  async function withNoAccessFallback(ids: string[]): Promise<string[]> {
    if (ids.length > 0) return ids;
    await ensureNoAccessGroup();
    return [NO_ACCESS_SQUAD_ID];
  }

  // A user's real (non-system) squads, as stored. Both system groups are dropped:
  // they are mutually exclusive with a real squad, and leaving "All" in place
  // would keep FULL ACCESS behind an echo that shows only the real squad.
  function realSquadsOf(dto: { groupIds: string[] }): string[] {
    return dto.groupIds.filter((g) => g !== NO_ACCESS_SQUAD_ID && g !== ALL_SQUAD_ID);
  }

  // Per-node "online now" counts from UserTraffic (both columns indexed).
  async function onlineByNodeMap(): Promise<Map<string, number>> {
    const cutoff = new Date(Date.now() - ONLINE_NOW_WINDOW_MS);
    const grouped = await prisma.userTraffic.groupBy({
      by: ['lastConnectedNodeId'],
      where: { user: { deletedAt: null }, onlineAt: { gte: cutoff }, lastConnectedNodeId: { not: null } },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.lastConnectedNodeId as string, g._count._all]));
  }

  // "Restart" = force a config + user re-push to the node via the existing
  // inbound-sync queue. There is no hard core-restart primitive (applyInbounds
  // is diffed agent-side); this recovers a node whose live config/user-map drifted.
  async function triggerNodeResync(nodeId: string): Promise<void> {
    await redis.set(inboundDirtyKey(nodeId), '1').catch(() => null);
    await inboundSyncQueue.add('applyNodeInbounds', { nodeId }, { jobId: `apply-${nodeId}` });
  }

  // Nodes a squad grants access to (Group → profiles → bindings → node).
  async function accessibleNodesForSquad(squadId: string) {
    const nodes = await prisma.node.findMany({
      where: {
        deletedAt: null,
        profileBindings: { some: { profile: { groupProfiles: { some: { groupId: squadId } } } } },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true, countryCode: true, status: true },
    });
    return nodes.map((n) => ({
      uuid: n.id,
      name: n.name,
      address: n.address,
      countryCode: n.countryCode,
      status: n.status,
    }));
  }

  // ─────────────── Users: lifecycle ───────────────

  // POST /api/users — create. Native create now accepts an absolute expireAt
  // (0.2.0 added it for panel-to-panel import), so the shop's create lands in a
  // SINGLE write. Only a disabled-on-create still needs a follow-up, because
  // native always creates a user active.
  app.post('/api/users', opts, async (request, reply) => {
    const body = RemnaCreateSchema.parse(request.body);
    const nativeInput = CreateUserSchema.parse({
      username: body.username,
      // Byte-precise (see bytesToNativeLimit): the shop exact-int-verifies the
      // echoed limit, so we must NOT quantize to GiB.
      trafficLimitBytes: bytesToNativeLimit(body.trafficLimitBytes ?? null),
      trafficLimitStrategy: strategyToNative(body.trafficLimitStrategy),
      hwidDeviceLimit: hwidLimitToNative(body.hwidDeviceLimit),
      telegramId: body.telegramId ?? undefined,
      email: body.email ?? undefined,
      description: body.description ?? undefined,
      tag: body.tag ?? undefined,
      externalSquadUuid: body.externalSquadUuid ?? undefined,
      // Absolute instant, straight into the create — no follow-up write, so the
      // row is never briefly committed with a NULL expireAt.
      expireAt: body.expireAt ?? undefined,
      groupIds: await resolveGroupIds(body.activeInternalSquads ?? []),
    });
    let dto = await usersService.createUser(nativeInput);

    // Anything still running after the row is committed can strand it: the shop
    // reads an error as "create failed" and never compensates, so a user it does
    // not know about would linger on the panel holding the username. Only two
    // things remain — the disabled-on-create follow-up and mapCtx() for the echo
    // — but both are AFTER the commit, so keep the create atomic-or-clean:
    // best-effort soft-delete before propagating, leaving the shop's "failed"
    // truthful and the username free for the retry.
    try {
      if (statusToNative(body.status) === 'disabled') {
        dto = await usersService.updateUser(dto.id, UpdateUserSchema.parse({ status: 'disabled' }));
      }
      return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
    } catch (err) {
      await usersService.deleteUser(dto.id).catch(() => {});
      throw err;
    }
  });

  // PATCH /api/users — update (uuid in body). Only fields present in the body
  // are forwarded (partial update).
  app.patch('/api/users', opts, async (request, reply) => {
    const body = RemnaUpdateSchema.parse(request.body);
    const patch: Record<string, unknown> = {};
    if (body.expireAt !== undefined) patch.expireAt = body.expireAt; // may be null → clears
    if (body.trafficLimitBytes !== undefined) patch.trafficLimitBytes = bytesToNativeLimit(body.trafficLimitBytes);
    if (body.trafficLimitStrategy !== undefined) patch.trafficLimitStrategy = strategyToNative(body.trafficLimitStrategy);
    if (body.hwidDeviceLimit !== undefined) patch.hwidDeviceLimit = hwidLimitToNative(body.hwidDeviceLimit);
    if (body.telegramId !== undefined) patch.telegramId = body.telegramId ?? null;
    if (body.email !== undefined) patch.email = body.email ?? null;
    if (body.externalSquadUuid !== undefined) patch.externalSquadUuid = body.externalSquadUuid ?? null;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.tag !== undefined) patch.tag = body.tag ?? null;
    if (body.activeInternalSquads !== undefined) {
      patch.groupIds = await resolveGroupIds(body.activeInternalSquads);
    }
    const nativeStatus = statusToNative(body.status);
    if (nativeStatus !== undefined) patch.status = nativeStatus;

    const userId = await resolveUserId(
      body.id !== undefined ? String(body.id) : body.uuid,
    );
    const dto = await usersService.updateUser(userId, UpdateUserSchema.parse(patch));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  // enable / disable / reset-traffic
  app.post('/api/users/:ref/actions/enable', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const userId = await resolveUserId(ref);
    const dto = await usersService.updateUser(userId, UpdateUserSchema.parse({ status: 'active' }));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  app.post('/api/users/:ref/actions/disable', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const userId = await resolveUserId(ref);
    const dto = await usersService.updateUser(userId, UpdateUserSchema.parse({ status: 'disabled' }));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  app.post('/api/users/:ref/actions/reset-traffic', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const dto = await usersService.resetUserTraffic(await resolveUserId(ref));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  // POST /api/users/:ref/actions/revoke — hand the subscriber a fresh link.
  //
  // Native `rotateSubscription` is exactly Remnawave's revoke: it issues a new
  // subscription token (so the old URL stops resolving) and clears any standing
  // revoke, so the link in the echoed `subscriptionUrl` is live. NOT native
  // `revokeSubscription`, which only stamps sub_revoked_at — that kills the link
  // without minting a replacement, and the shop shows the user the dead one.
  //
  // The shop deletes the user's HWID devices itself before calling this, so the
  // device limit does not have to be cleared here.
  app.post('/api/users/:ref/actions/revoke', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const dto = await usersService.rotateSubscription(await resolveUserId(ref));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  // DELETE /api/users/:uuid — soft delete (minishop only checks `not error`).
  app.delete('/api/users/:ref', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    await usersService.deleteUser(await resolveUserId(ref));
    return sendResponse(reply, { deleted: true });
  });

  // ─────────────── Users: reads ───────────────

  // Static children (stream / by-*) are registered as their own paths; find-my-way
  // prefers them over the `:uuid` param at the same depth.

  // GET /api/users/stream — cursor pagination (cursor = numeric offset).
  //
  // FILTERS ARE NOT OPTIONAL HERE. In 3.x the stream replaces the by-telegram-id
  // and by-email lookup routes, and the client has no fallback for it: once it
  // knows the panel is 3.x, a failing stream is logged as an error and the read
  // is abandoned rather than retried against /users. Ignoring the filter would
  // technically still work — the client re-checks every row it receives — but a
  // single telegram lookup would then page the entire user table.
  app.get('/api/users/stream', opts, async (request, reply) => {
    const q = request.query as {
      size?: string;
      cursor?: string;
      telegramId?: string;
      email?: string;
    };
    const size = Math.min(Math.max(parseInt(q.size ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(q.cursor ?? '0', 10) || 0, 0);
    const page = Math.floor(offset / size) + 1;
    // An unparseable telegramId is pinned to a value no row can hold rather than
    // dropped: dropping it would widen the query to EVERY user and the client
    // would take that page as the lookup's answer.
    const telegramId =
      q.telegramId === undefined ? undefined : (parseTelegramId(q.telegramId) ?? NO_SUCH_ID);
    const { users, total } = await usersService.listUsers({
      page,
      limit: size,
      ...(telegramId !== undefined ? { telegramId } : {}),
      ...(q.email !== undefined ? { email: q.email } : {}),
      // Pin the order explicitly: the shop walks these pages to build a
      // full picture of the panel, so the sort must be stable and identical
      // across both pagination routes. (Upstream made sort/order required
      // when it added server-side sorting; this keeps the previous
      // newest-first ordering the facade has always emitted.)
      sort: 'createdAt',
      order: 'desc',
    });
    const ctx = await mapCtx();
    const nextCursor = users.length < size ? null : String(offset + size);
    return sendResponse(reply, {
      users: users.map((u) => mapUserToRemna(u, ctx)),
      total,
      nextCursor,
    });
  });

  // GET /api/users — offset pagination (size + start). The cap MUST be >= the
  // shop's page size (PANEL_ALL_USERS_PAGE_SIZE, default 1000): the shop's
  // offset loop terminates on `len(batch) < page_size`, so a smaller cap returns
  // a short first page that stops the loop early — the shop then treats users
  // past the cap as absent and deactivates their (paid) subscriptions. This is
  // the fallback path (primary is /users/stream, cursor-driven); it fires on a
  // transient stream error, so the cap must match the shop's page size.
  app.get('/api/users', opts, async (request, reply) => {
    const q = request.query as { size?: string; start?: string };
    const size = Math.min(Math.max(parseInt(q.size ?? '100', 10) || 100, 1), 1000);
    const start = Math.max(parseInt(q.start ?? '0', 10) || 0, 0);
    const page = Math.floor(start / size) + 1;
    const { users, total } = await usersService.listUsers({
      page,
      limit: size,
      // Pin the order explicitly: the shop walks these pages to build a
      // full picture of the panel, so the sort must be stable and identical
      // across both pagination routes. (Upstream made sort/order required
      // when it added server-side sorting; this keeps the previous
      // newest-first ordering the facade has always emitted.)
      sort: 'createdAt',
      order: 'desc',
    });
    const ctx = await mapCtx();
    return sendResponse(reply, { users: users.map((u) => mapUserToRemna(u, ctx)), total });
  });

  // by-telegram-id and by-email are 2.x-only routes: in 3.x the client looks a
  // user up by streaming with a filter (see /api/users/stream above) and never
  // calls these, so serving them would be dead surface. by-username stays — it
  // is unchanged across both generations.

  // GET /api/users/by-username/:username — single dict; A062 when absent so the
  // minishop treats it as "no such user" rather than an error.
  app.get('/api/users/by-username/:username', opts, async (request, reply) => {
    const { username } = request.params as { username: string };
    const row = await prisma.user.findFirst({
      where: { username, deletedAt: null },
      include: USER_INCLUDE,
    });
    if (!row) throw new RemnaError(404, 'A062', 'user not found');
    return sendResponse(reply, mapUserToRemna(mapUserToPublic(row, row.traffic), await mapCtx()));
  });

  // GET /api/users/:uuid — single dict.
  app.get('/api/users/:ref', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    return sendResponse(reply, mapUserToRemna(await resolveUserRef(ref), await mapCtx()));
  });

  // ─────────────── Squads (internal + external) ───────────────

  // GET /api/internal-squads — iceslab Groups as {uuid,name}. BOTH system groups
  // are hidden: the no-access group (internal artifact) AND the seeded "All"
  // squad. Hiding "All" is load-bearing, not cosmetic — mapUserToRemna strips it
  // from activeInternalSquads on reads (it means "full access", not a real
  // squad), so if it were pickable here an operator could assign it and every
  // read would echo [] ≠ [ALL], failing the shop's exact set-equality
  // entitlement verify and rolling back every paid activation for that tariff.
  // Picker and reader MUST agree on the hidden set.
  app.get('/api/internal-squads', opts, async (_request, reply) => {
    const squads = (await squadsService.listSquads()).filter(
      (s) => s.id !== NO_ACCESS_SQUAD_ID && s.id !== ALL_SQUAD_ID,
    );
    return sendResponse(reply, {
      internalSquads: squads.map((s) => ({
        uuid: s.id,
        name: s.name,
        membersCount: s.memberCount,
      })),
      total: squads.length,
    });
  });

  // GET /api/internal-squads/:uuid — the two system groups are hidden from the
  // list, so treat a direct lookup of them as not-found for consistency (they
  // are never a shop-pickable squad; see the list route).
  app.get('/api/internal-squads/:uuid', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    if (uuid === ALL_SQUAD_ID || uuid === NO_ACCESS_SQUAD_ID) {
      throw new RemnaError(404, 'NOT_FOUND', 'squad not found');
    }
    const s = await squadsService.getSquadById(uuid); // throws SquadNotFoundError → 404
    return sendResponse(reply, { uuid: s.id, name: s.name, membersCount: s.memberCount });
  });

  // GET /api/internal-squads/:uuid/accessible-nodes (+ /nodes fallback) — the
  // node set a squad grants (Group → profiles → bindings → nodes). Unknown or
  // profile-less squad → []; the minishop treats [] the same as an error.
  app.get('/api/internal-squads/:uuid/accessible-nodes', opts, async (request, reply) =>
    sendResponse(reply, await accessibleNodesForSquad((request.params as { uuid: string }).uuid)),
  );
  app.get('/api/internal-squads/:uuid/nodes', opts, async (request, reply) =>
    sendResponse(reply, await accessibleNodesForSquad((request.params as { uuid: string }).uuid)),
  );

  // POST /api/connections/drop — tear down a user's live sessions so a tariff
  // change takes effect now instead of at their next reconnect. Capability
  // `connections-drop`.
  //
  // The primitive is per-user and live: every CoreAdapter has RemoveUser, and
  // xray's runs `xray api` (liveUpdateUser) rather than rewriting the config, so
  // it drops THAT user's sessions and leaves everyone else on the node alone.
  // Restarting the core would drop the whole node - never what an admin asked
  // for here.
  //
  // The hazard is the gap. Removing an ACTIVE user and failing to add them back
  // leaves a paying subscriber off that node until something else repairs it -
  // strictly worse than not serving this route at all, where the shop's own
  // fallback is benign ("live sessions stay until nodes drop them"). Note we
  // cannot reuse syncRemoveUser: it status-gates and refuses to touch an active
  // user, which is exactly the user this route is about. So the add-back is
  // unconditional, and any failure hands the user to the proven idempotent
  // `addUser` job instead of being reported as a success.
  app.post('/api/connections/drop', opts, async (request, reply) => {
    const body = DropConnectionsSchema.parse(request.body ?? {});
    const refs: (string | number)[] = body.dropBy?.userIds ?? body.dropBy?.userUuids ?? [];
    const wanted = body.targetNodes?.nodeUuids ?? [];
    const nodes = await prisma.node.findMany({
      where: {
        deletedAt: null,
        status: { not: 'disabled' },
        ...(body.targetNodes?.target === 'specificNodes' && wanted.length > 0
          ? { id: { in: wanted } }
          : {}),
      },
      select: { id: true, name: true, address: true },
    });
    // A219 is the client's own code for "no connected node matched"; it logs
    // "nothing to tear down" and moves on. Saying that is honest, where a 200
    // would claim we dropped sessions on nodes that do not exist.
    if (nodes.length === 0) {
      throw new RemnaError(400, 'A219', 'no active node matched the requested target');
    }

    let dropped = 0;
    const repaired: string[] = [];
    for (const ref of refs) {
      const dto = await resolveUserRef(String(ref)).catch(() => null);
      if (!dto) continue;
      // Built once per user, before touching any node: if the user is not
      // active there is nothing to add back, and removing them without an
      // add-back is what the lifecycle jobs are for, not this route.
      const payload = await buildAddUserRequest(dto.id);
      if (payload.kind !== 'ok') continue;
      // Across nodes concurrently, sequentially WITHIN a node: remove-then-add
      // on the same node is an ordering, but two nodes are independent. Serial
      // over both would make a 500-user chunk take nodes x users round trips,
      // long enough for the shop's own HTTP timeout to fire and read the whole
      // call as failed while we were still working.
      const results = await Promise.allSettled(
        nodes.map(async (node) => {
          const transport = new NodeTransport(node);
          await transport.removeUser({ userId: dto.id });
          await transport.addUser(payload.req);
        }),
      );
      const ok = results.every((r) => r.status === 'fulfilled');
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          getLogger().warn(
            { err: r.reason, userId: dto.id, node: nodes[i]?.name },
            '[remnawave-compat] connections/drop failed mid-cycle; queueing addUser repair',
          );
        }
      }
      if (ok) {
        dropped += 1;
      } else {
        // Idempotent, retried, and status-gated the right way round: it only
        // re-adds a user who is still active.
        await nodeUsersQueue.add('addUser', { userId: dto.id });
        repaired.push(dto.id);
      }
    }
    return sendResponse(reply, {
      affectedRows: dropped,
      ...(repaired.length > 0 ? { repairQueued: repaired.length } : {}),
    });
  });

  // POST /api/users/bulk/update-squads — set the EXACT squad set on many users at
  // once. Capability `bulk-squad-update`; the shop's efficient path for a tariff
  // change that moves a batch of subscribers between squads.
  //
  // Two details of the client contract, both easy to get wrong in a way that
  // still looks like success (panel_api_squads.py:169-198):
  //
  //  1. The count comes back as `affectedRows`, not `affected` like our other
  //     bulk routes. The client reads it with `.get("affectedRows")` and only
  //     compares when it is an int - so a wrong key yields None, no complaint,
  //     and a bulk it believes worked. There is a test for the key alone.
  //  2. `affectedRows < len(chunk)` means FAILURE to the client, and it falls
  //     back to per-user PATCH for the whole chunk. So a user already in the
  //     desired state must still be counted: "affected" here means "matched and
  //     now in the requested state", not "rows we wrote". Counting writes would
  //     make the efficient path report failure precisely when it had least to do.
  //
  // An empty `activeInternalSquads` never arrives: the client refuses to send it
  // (Remnawave 3.0.0 answers A088/500) and uses per-user PATCH for that state.
  // We still backstop through resolveGroupIds, which lands an empty set in
  // no-access rather than native's "All" = full access.
  app.post('/api/users/bulk/update-squads', opts, async (request, reply) => {
    const body = BulkUpdateSquadsSchema.parse(request.body ?? {});
    const refs: (string | number)[] = body.userIds ?? body.uuids ?? [];
    const groupIds = await resolveGroupIds(body.activeInternalSquads ?? []);
    let affectedRows = 0;
    for (const ref of refs) {
      // A reference this panel never issued is skipped, not fatal - same as the
      // other bulk routes: erroring would abandon the rest of the chunk.
      const dto = await resolveUserRef(String(ref)).catch(() => null);
      if (!dto) continue;
      const current = [...dto.groupIds].sort();
      const desired = [...groupIds].sort();
      const already =
        current.length === desired.length && current.every((g, i) => g === desired[i]);
      // Counted either way - see (2) above. Only the write is conditional.
      if (!already) {
        await usersService.updateUser(dto.id, UpdateUserSchema.parse({ groupIds }));
      }
      affectedRows += 1;
    }
    return sendResponse(reply, { affectedRows });
  });

  // POST /api/internal-squads/:uuid/bulk-actions/add-many-users — membership is
  // a full-set replacement of groupIds on the user; add = read-modify-write.
  // Adding a real squad drops the no-access group (they're mutually exclusive).
  //
  // `add-many-users` is the 3.x spelling, and it is NOT optional the way the
  // other 3.x-only routes are: the client has no per-user fallback for it once
  // it holds numeric ids, so a 404 here does not degrade squad assignment, it
  // stops it. (The 2.x route was `add-users`, which meant ALL users and which
  // the client therefore never calls — serving it was dead surface.)
  app.post('/api/internal-squads/:uuid/bulk-actions/add-many-users', opts, async (request, reply) => {
    // Normalise the target the same way as create/PATCH: a case-variant uuid
    // would miss the "already a member" check and then collide on the
    // group_members PK (500), and the system groups are never a valid target.
    const [uuid] = normalizeSquadIds([(request.params as { uuid: string }).uuid]);
    const body = BulkUsersSchema.parse(request.body ?? {});
    const refs = body.userIds ?? [];
    let affected = 0;
    for (const ref of refs) {
      // A reference this panel never issued is skipped, not fatal: the client
      // sends a whole chunk and an error would abandon the rest of it.
      const dto = await resolveUserRef(String(ref)).catch(() => null);
      if (!dto) continue;
      const base = realSquadsOf(dto);
      if (uuid && base.includes(uuid)) continue;
      await usersService.updateUser(dto.id, UpdateUserSchema.parse({ groupIds: [...base, uuid] }));
      affected += 1;
    }
    return sendResponse(reply, { affected });
  });

  // DELETE /api/internal-squads/:uuid/bulk-actions/remove-users — removing the
  // last squad drops the user into the no-access group (not the "All" squad).
  app.delete('/api/internal-squads/:uuid/bulk-actions/remove-many-users', opts, async (request, reply) => {
    const [uuid] = normalizeSquadIds([(request.params as { uuid: string }).uuid]);
    const body = BulkUsersSchema.parse(request.body ?? {});
    const refs = body.userIds ?? [];
    let affected = 0;
    for (const ref of refs) {
      const dto = await resolveUserRef(String(ref)).catch(() => null);
      if (!dto) continue;
      if (!dto.groupIds.includes(uuid!)) continue;
      // Drop the removed squad AND any system group, then backstop: losing
      // your last real squad must land in no-access, never in "All".
      const next = realSquadsOf(dto).filter((g) => g !== uuid);
      await usersService.updateUser(
        dto.id,
        UpdateUserSchema.parse({ groupIds: await withNoAccessFallback(next) }),
      );
      affected += 1;
    }
    return sendResponse(reply, { affected });
  });

  // GET /api/external-squads/:uuid — iceslab has no external-squad entity; the
  // minishop only uses this to read an install-guides subpage pointer (which we
  // don't have → null → guides fall back). The per-user externalSquadUuid is
  // persisted+echoed on the user object instead (that's the load-bearing part).
  // Echo the requested uuid so any reader sees a coherent object.
  app.get('/api/external-squads/:uuid', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    return sendResponse(reply, { uuid, name: uuid, membersCount: 0, subpageConfigUuid: null });
  });

  // ─────────────── Subscription ───────────────

  // GET /api/sub/:token — the minishop's degraded-mode fallback constructs the
  // sub link as PANEL_API_URL + /sub/<token> = /<prefix>/api/sub/<token>. Bounce
  // it to the real client sub URL. PUBLIC (the end-user's client fetches it, no
  // token); the redirect target is fixed to our own origin (no open redirect).
  app.get(
    '/api/sub/:token',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      return reply.redirect(`${subscriptionOrigin()}${config.SUBSCRIPTION_PATH_PREFIX}/${token}`);
    },
  );

  // Subscription page config — display-only; the minishop MiniApp renders from
  // `subscriptionUrl`, so these are cosmetic.
  app.get('/api/subscriptions/subpage-config/:shortUuid', opts, async (_request, reply) =>
    sendResponse(reply, {}),
  );
  app.get('/api/subscription-page-configs', opts, async (_request, reply) => sendResponse(reply, {}));
  app.get('/api/subscription-page-configs/:uuid', opts, async (_request, reply) =>
    sendResponse(reply, {}),
  );

  // ─────────────── System / metadata ───────────────

  // GET /api/system/metadata — the version probe, and the single place where
  // this facade declares WHICH Remnawave API it speaks.
  //
  // The client reads `response.version`, takes the major, and derives the whole
  // contract from it: 3 means numeric user identity, the cursor stream with
  // lookup filters, and the targeted squad-bulk routes. Everything else in this
  // module exists to make that declaration true — so this string and the shapes
  // below move together or not at all.
  //
  // 3.3.2 is the client's certified preset for that generation (its
  // remnawave_support.json), which puts us on the matrix it actually tests
  // rather than in the best-effort mode an unrecognised version falls into.
  //
  // (happ link encryption used to live under System/tools. The shop encrypts
  // those links locally now and the route is gone from its registry, so the
  // stub it used to need went with it.)
  app.get('/api/system/metadata', opts, async (_request, reply) =>
    sendResponse(reply, { version: REMNAWAVE_API_VERSION }),
  );

  // ─────────────── System / stats / bandwidth ───────────────

  // GET /api/system/stats — real, from the (cached, single-flighted) dashboard
  // overview. statusCounts keys must be UPPERCASE (native byStatus is lowercase).
  app.get('/api/system/stats', opts, async (_request, reply) => {
    const o = await getOverview();
    const statusCounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.users.byStatus)) statusCounts[k.toUpperCase()] = v;
    return sendResponse(reply, {
      users: { totalUsers: o.users.total, statusCounts },
      onlineStats: {
        onlineNow: o.users.onlineNow,
        lastDay: o.users.onlineToday,
        lastWeek: o.users.onlineThisWeek,
        neverOnline: o.users.neverOnline,
      },
      memory: { total: o.host.memory.totalBytes, used: o.host.memory.usedBytes },
      nodes: { totalOnline: o.system.onlineNodeCount, total: o.system.totalNodeCount },
      usersOnline: o.users.onlineNow,
    });
  });

  // GET /api/system/stats/bandwidth — the minishop reads `current`/`previous` as
  // display STRINGS (printed verbatim), so format via formatBytes.
  app.get('/api/system/stats/bandwidth', opts, async (_request, reply) => {
    const o = await getOverview();
    const fmt = (n: number) => formatBytes(BigInt(Math.round(n)));
    const pair = (cur: number, prev: number) => ({ current: fmt(cur), previous: fmt(prev) });
    const last30 = pair(o.traffic.last30dBytes, o.traffic.prev30dBytes);
    return sendResponse(reply, {
      bandwidthLastTwoDays: pair(o.traffic.todayBytes, o.traffic.yesterdayBytes),
      bandwidthLastSevenDays: pair(o.traffic.last7dBytes, o.traffic.prev7dBytes),
      bandwidthLast30Days: last30,
      bandwidthLastThirtyDays: last30, // minishop tries both key spellings
      bandwidthCalendarMonth: pair(o.traffic.calendarMonthBytes, o.traffic.lastCalendarMonthBytes),
      bandwidthCurrentYear: pair(o.traffic.currentYearBytes, o.traffic.lastYearBytes),
    });
  });

  // GET /api/system/stats/nodes — nodes[] with usersOnline. lastSevenDays must
  // carry one row PER NODE: the minishop's node-count branches on the key being
  // PRESENT (not on content) and counts unique nodeName — an empty array there
  // makes it render "Nodes: 0/0" instead of the real count (the totalOnline
  // fallback only fires when the key is absent). Node names are already fetched.
  app.get('/api/system/stats/nodes', opts, async (_request, reply) => {
    const [nodes, onlineByNode] = await Promise.all([
      prisma.node.findMany({ where: { deletedAt: null }, select: { id: true, name: true, countryCode: true } }),
      onlineByNodeMap(),
    ]);
    return sendResponse(reply, {
      nodes: nodes.map((n) => ({
        uuid: n.id,
        name: n.name,
        countryCode: n.countryCode,
        usersOnline: onlineByNode.get(n.id) ?? 0,
      })),
      lastSevenDays: nodes.map((n) => ({ nodeName: n.name, totalBytes: 0 })),
    });
  });

  // GET /api/bandwidth-stats/nodes — topNodes by total bytes over a date range.
  app.get('/api/bandwidth-stats/nodes', opts, async (request, reply) => {
    const q = request.query as { start?: string; end?: string; topNodesLimit?: string };
    const limit = Math.min(Math.max(parseInt(q.topNodesLimit ?? '64', 10) || 64, 1), 1000);
    const { startTs, endTs } = dateRangeExclusiveEnd(q.start, q.end);
    const grouped = await prisma.nodeUsageHistory.groupBy({
      by: ['nodeId'],
      where: { hour: { gte: startTs, lt: endTs } },
      _sum: { downloadBytes: true, uploadBytes: true },
    });
    const meta = new Map(
      (
        await prisma.node.findMany({
          where: { id: { in: grouped.map((g) => g.nodeId) } },
          select: { id: true, name: true, countryCode: true },
        })
      ).map((n) => [n.id, n]),
    );
    const topNodes = grouped
      .map((g) => ({
        uuid: g.nodeId,
        name: meta.get(g.nodeId)?.name ?? g.nodeId,
        countryCode: meta.get(g.nodeId)?.countryCode ?? null,
        total: Number(g._sum.downloadBytes ?? 0n) + Number(g._sum.uploadBytes ?? 0n),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
    return sendResponse(reply, { topNodes });
  });

  // GET /api/bandwidth-stats/users/:ref — cheap real total. Node uuids stay
  // uuids: 3.x renumbered users only.
  app.get('/api/bandwidth-stats/users/:ref', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const dto = await resolveUserRef(ref);
    const grouped = await prisma.nodeUserUsageHistory.groupBy({
      by: ['nodeId'],
      where: { userId: dto.id },
      _sum: { bytesIn: true, bytesOut: true },
    });
    const nodes = grouped.map((g) => ({
      uuid: g.nodeId,
      total: Number(g._sum.bytesIn ?? 0n) + Number(g._sum.bytesOut ?? 0n),
    }));
    return sendResponse(reply, {
      id: Number(dto.numericId),
      total: nodes.reduce((s, n) => s + n.total, 0),
      nodes,
    });
  });

  // GET /api/bandwidth-stats/nodes/:uuid/users — per-node per-user totals (drives
  // the premium tariff worker's per-node billing → accuracy matters).
  app.get('/api/bandwidth-stats/nodes/:uuid/users', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const q = request.query as { start?: string; end?: string; topUsersLimit?: string };
    const limit = Math.min(Math.max(parseInt(q.topUsersLimit ?? '10000', 10) || 10000, 1), 100_000);
    const startDate = parseUtcDay(q.start, new Date(0));
    const endDate = parseUtcDay(q.end, new Date());
    const rows = await prisma.nodeUserUsageHistory.groupBy({
      by: ['userId'],
      where: { nodeId: uuid, date: { gte: startDate, lte: endDate } },
      _sum: { bytesIn: true, bytesOut: true },
      orderBy: { _sum: { bytesIn: 'desc' } },
      take: limit,
    });
    const names = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.userId) } },
          select: { id: true, username: true },
        })
      ).map((u) => [u.id, u.username]),
    );
    const topUsers = rows.map((r) => ({
      user: { uuid: r.userId, username: names.get(r.userId) ?? null },
      total: Number(r._sum.bytesIn ?? 0n) + Number(r._sum.bytesOut ?? 0n),
    }));
    return sendResponse(reply, { topUsers });
  });

  // POST /api/bandwidth-stats/nodes/users — the aggregate top-users list across a
  // SET of nodes, which is what the shop asks for when it bills a premium tariff
  // over several nodes at once. The per-node GET above answers one node; this
  // answers many and merges, so a user who moved between nodes in the window is
  // one row, not several.
  //
  // Capability `multi-node-top-users`. It was deliberately unserved while the
  // shop could not certify our declared version - it never called it then. The
  // shop's `dev` (1c20764a) certifies 3.3.2, at which point it does call it, so
  // serving it is no longer optional decoration.
  app.post('/api/bandwidth-stats/nodes/users', opts, async (request, reply) => {
    const q = request.query as { start?: string; end?: string; topUsersLimit?: string };
    const body = NodesUuidsSchema.parse(request.body ?? {});
    const nodes = body.nodesUuids ?? [];
    // An empty node set is a real question with a real answer, and the shop
    // short-circuits it on its side anyway; answering [] beats a 400.
    if (nodes.length === 0) return sendResponse(reply, { topUsers: [] });
    const limit = Math.min(Math.max(parseInt(q.topUsersLimit ?? '10000', 10) || 10000, 1), 100_000);
    const startDate = parseUtcDay(q.start, new Date(0));
    const endDate = parseUtcDay(q.end, new Date());
    const rows = await prisma.nodeUserUsageHistory.groupBy({
      by: ['userId'],
      where: { nodeId: { in: nodes }, date: { gte: startDate, lte: endDate } },
      _sum: { bytesIn: true, bytesOut: true },
    });
    const users = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: rows.map((r) => r.userId) } },
          select: { id: true, username: true, numericId: true },
        })
      ).map((u) => [u.id, u]),
    );
    // Sorted on the MERGED total, not on one column: grouping by user across
    // nodes changes the ranking, so ordering by the query's bytesIn (as the
    // single-node route can) would truncate the wrong users at the limit.
    const topUsers = rows
      .map((r) => {
        const u = users.get(r.userId);
        return {
          user: {
            uuid: r.userId,
            id: u ? Number(u.numericId) : null,
            username: u?.username ?? null,
          },
          total: Number(r._sum.bytesIn ?? 0n) + Number(r._sum.bytesOut ?? 0n),
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
    return sendResponse(reply, { topUsers });
  });

  // POST /api/bandwidth-stats/nodes/usage — per-node per-user totals for a set of
  // nodes, the 3.x shape. Capability `multi-node-usage`.
  //
  // Two things about the shop's parser decide the shape of this handler
  // (tariff_worker_premium_usage.py `_snapshot_from_v3_usage`):
  //
  //  1. A node entry that is not an object, or lacks a uuid, or whose `users` is
  //     not an array, makes it discard the WHOLE snapshot and fall back. So every
  //     entry is complete or the response is worthless.
  //  2. It pre-seeds a zero lookup for every node it ASKED about, then overwrites
  //     from the response. A node we omit therefore reads as "no traffic" rather
  //     than "unknown" - silently, in the path that bills premium tariffs. So we
  //     answer for every requested node, including the ones with nothing.
  app.post('/api/bandwidth-stats/nodes/usage', opts, async (request, reply) => {
    const q = request.query as { start?: string; end?: string; minTotalBytes?: string };
    const body = NodesUuidsSchema.parse(request.body ?? {});
    const nodes = body.nodesUuids ?? [];
    if (nodes.length === 0) return sendResponse(reply, { nodes: [] });
    const minTotal = Math.max(parseInt(q.minTotalBytes ?? '0', 10) || 0, 0);
    const startDate = parseUtcDay(q.start, new Date(0));
    const endDate = parseUtcDay(q.end, new Date());
    const rows = await prisma.nodeUserUsageHistory.groupBy({
      by: ['nodeId', 'userId'],
      where: { nodeId: { in: nodes }, date: { gte: startDate, lte: endDate } },
      _sum: { bytesIn: true, bytesOut: true },
    });
    const users = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
          select: { id: true, username: true, numericId: true },
        })
      ).map((u) => [u.id, u]),
    );
    const perNode = new Map<string, { id: number | null; uuid: string; username: string | null; totalBytes: number }[]>(
      nodes.map((n) => [n, []]),
    );
    for (const r of rows) {
      const total = Number(r._sum.bytesIn ?? 0n) + Number(r._sum.bytesOut ?? 0n);
      if (total < minTotal) continue;
      const u = users.get(r.userId);
      // A user row whose numericId we cannot resolve is dropped rather than sent
      // with a null id: the shop keys usage by `String(id)`, so "null" would
      // become a bucket that no user ever matches and the bytes would vanish
      // into it instead of being attributed.
      if (!u) continue;
      perNode.get(r.nodeId)?.push({
        id: Number(u.numericId),
        uuid: r.userId,
        username: u.username,
        totalBytes: total,
      });
    }
    return sendResponse(reply, {
      nodes: nodes.map((uuid) => ({
        uuid,
        users: (perNode.get(uuid) ?? []).sort((a, b) => b.totalBytes - a.totalBytes),
      })),
    });
  });

  // ─────────────── HWID devices ───────────────

  // GET /api/hwid/devices/:userUuid — list a user's devices (metadata nullable).
  app.get('/api/hwid/devices/:ref', opts, async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const rows = await hwidService.listUserDevices(await resolveUserId(ref));
    return sendResponse(reply, { devices: rows.map(mapDevice) });
  });

  // POST /api/hwid/devices/delete {userId, hwid} — the 3.x selector is the
  // numeric `userId` (2.x sent `userUuid`; both are accepted, and the client
  // learns which one this panel takes from the first success). Missing device →
  // idempotent {deleted:false} (200) so the minishop still invalidates its cache
  // instead of showing an error.
  app.post('/api/hwid/devices/delete', opts, async (request, reply) => {
    const body = z
      .object({
        userId: z.union([z.number().int(), z.string()]).optional(),
        userUuid: z.string().optional(),
        hwid: z.string().min(1).max(255),
      })
      .loose()
      .parse(request.body);
    const userId = await resolveUserId(
      body.userId !== undefined ? String(body.userId) : body.userUuid,
    );
    // Single atomic statement instead of find-then-delete-by-id: the read/write
    // gap let two concurrent deletes of the same device both resolve a row, and
    // the loser's delete-by-id then threw P2025 ("record required but not
    // found") — a 500 for work that was already done. deleteMany is a no-op when
    // the row is gone, so a repeat/concurrent delete is simply {deleted:false}.
    const { count } = await prisma.hwidUserDevice.deleteMany({
      where: { userId, hwid: body.hwid },
    });
    return sendResponse(reply, { deleted: count > 0 });
  });

  // GET /api/hwid/devices/stats — aggregate device counts (no per-app data → byApp:[]).
  app.get('/api/hwid/devices/stats', opts, async (_request, reply) => {
    const [totalHwidDevices, uniqueDevices, usersWith, byPlatformRaw] = await Promise.all([
      prisma.hwidUserDevice.count(),
      prisma.hwidUserDevice.groupBy({ by: ['hwid'] }),
      prisma.hwidUserDevice.groupBy({ by: ['userId'] }),
      prisma.hwidUserDevice.groupBy({ by: ['platform'], _count: { _all: true } }),
    ]);
    const usersWithDevices = usersWith.length;
    return sendResponse(reply, {
      stats: {
        totalUniqueDevices: uniqueDevices.length,
        totalHwidDevices,
        averageHwidDevicesPerUser: usersWithDevices ? totalHwidDevices / usersWithDevices : 0,
      },
      byPlatform: byPlatformRaw.map((g) => ({
        platform: g.platform ?? 'unknown',
        count: g._count._all,
        byApp: [],
      })),
    });
  });

  // GET /api/hwid/devices/top-users?start&size — users ranked by device count.
  app.get('/api/hwid/devices/top-users', opts, async (request, reply) => {
    const q = request.query as { start?: string; size?: string };
    const size = Math.min(Math.max(parseInt(q.size ?? '10', 10) || 10, 1), 500);
    const start = Math.max(parseInt(q.start ?? '0', 10) || 0, 0);
    const groups = await prisma.hwidUserDevice.groupBy({
      by: ['userId'],
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      skip: start,
      take: size,
    });
    const names = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: groups.map((g) => g.userId) } },
          select: { id: true, username: true },
        })
      ).map((u) => [u.id, u.username]),
    );
    return sendResponse(reply, {
      users: groups.map((g) => ({
        userId: g.userId,
        username: names.get(g.userId) ?? null,
        devicesCount: g._count._all,
      })),
    });
  });

  // ─────────────── Nodes (list + restart) ───────────────

  // GET /api/nodes — {uuid,name,usersOnline}, PAGINATED via start/size. Slicing is
  // load-bearing: the minishop loops until a short page, so an unpaginated full
  // array of ≥100 nodes would loop forever.
  app.get('/api/nodes', opts, async (request, reply) => {
    const q = request.query as { size?: string; start?: string };
    const size = Math.min(Math.max(parseInt(q.size ?? '100', 10) || 100, 1), 500);
    const start = Math.max(parseInt(q.start ?? '0', 10) || 0, 0);
    const [all, onlineByNode] = await Promise.all([
      prisma.node.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      onlineByNodeMap(),
    ]);
    const page = all.slice(start, start + size).map((n) => ({
      uuid: n.id,
      name: n.name,
      usersOnline: onlineByNode.get(n.id) ?? 0,
    }));
    return sendResponse(reply, page);
  });

  // POST /api/nodes/:uuid/actions/restart — re-push config+users to the node.
  app.post('/api/nodes/:uuid/actions/restart', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const exists = await prisma.node.count({ where: { id: uuid, deletedAt: null } });
    if (!exists) throw new RemnaError(404, 'NOT_FOUND', 'node not found');
    await triggerNodeResync(uuid);
    return sendResponse(reply, { restarted: true });
  });

  // POST /api/nodes/actions/restart-all — re-push every active node.
  app.post('/api/nodes/actions/restart-all', opts, async (_request, reply) => {
    const nodes = await prisma.node.findMany({
      where: { deletedAt: null, status: { not: 'disabled' } },
      select: { id: true },
    });
    await Promise.all(nodes.map((n) => triggerNodeResync(n.id)));
    return sendResponse(reply, { restarted: nodes.length });
  });

  // ─────────────── Hosts ───────────────

  // GET /api/hosts — bare array; isDisabled from the live enabled-chain (host +
  // binding + profile), isHidden constant false (no native "hidden" column),
  // inboundUuid = the ProfileNodeBinding id (the wire "inbound" identity).
  app.get('/api/hosts', opts, async (_request, reply) => {
    const rows = await prisma.host.findMany({
      include: { binding: { select: { enabled: true, profile: { select: { enabled: true } } } } },
    });
    return sendResponse(
      reply,
      rows.map((h) => ({
        uuid: h.id,
        remark: h.remark,
        isDisabled: !(h.enabled && h.binding.enabled && h.binding.profile.enabled),
        isHidden: false,
        inboundUuid: h.bindingId,
        configProfileInboundUuid: h.bindingId,
      })),
    );
  });
}
