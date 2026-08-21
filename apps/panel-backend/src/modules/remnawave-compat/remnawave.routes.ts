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

// Same include the users repository uses, so mapUserToPublic sees traffic +
// group membership for the facade's direct lookups (by-telegram-id/email/username).
const USER_INCLUDE = {
  traffic: true,
  groupMembers: { select: { groupId: true } },
} as const;

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
const RemnaUpdateSchema = RemnaCreateSchema.extend({
  uuid: z.string(),
  username: z.string().optional(),
});

// Bulk squad membership: cap the array so one request can't fan out into an
// unbounded number of per-user DB writes (each id = a getUserById + updateUser).
const BulkUsersSchema = z
  .object({
    users: z.array(z.string()).max(1000).optional(),
    userUuids: z.array(z.string()).max(1000).optional(),
  })
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

    const dto = await usersService.updateUser(body.uuid, UpdateUserSchema.parse(patch));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  // enable / disable / reset-traffic
  app.post('/api/users/:uuid/actions/enable', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const dto = await usersService.updateUser(uuid, UpdateUserSchema.parse({ status: 'active' }));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  app.post('/api/users/:uuid/actions/disable', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const dto = await usersService.updateUser(uuid, UpdateUserSchema.parse({ status: 'disabled' }));
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  app.post('/api/users/:uuid/actions/reset-traffic', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const dto = await usersService.resetUserTraffic(uuid);
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
  });

  // DELETE /api/users/:uuid — soft delete (minishop only checks `not error`).
  app.delete('/api/users/:uuid', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    await usersService.deleteUser(uuid);
    return sendResponse(reply, { deleted: true });
  });

  // ─────────────── Users: reads ───────────────

  // Static children (stream / by-*) are registered as their own paths; find-my-way
  // prefers them over the `:uuid` param at the same depth.

  // GET /api/users/stream — cursor pagination (cursor = numeric offset).
  app.get('/api/users/stream', opts, async (request, reply) => {
    const q = request.query as { size?: string; cursor?: string };
    const size = Math.min(Math.max(parseInt(q.size ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(q.cursor ?? '0', 10) || 0, 0);
    const page = Math.floor(offset / size) + 1;
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

  // GET /api/users/by-telegram-id/:tg — array (Remnawave allows many per tg).
  app.get('/api/users/by-telegram-id/:tg', opts, async (request, reply) => {
    const { tg } = request.params as { tg: string };
    let tgId: bigint;
    try {
      tgId = BigInt(tg);
    } catch {
      return sendResponse(reply, []);
    }
    const rows = await prisma.user.findMany({
      where: { telegramId: tgId, deletedAt: null },
      include: USER_INCLUDE,
    });
    const ctx = await mapCtx();
    return sendResponse(reply, rows.map((u) => mapUserToRemna(mapUserToPublic(u, u.traffic), ctx)));
  });

  // GET /api/users/by-email/:email — array.
  app.get('/api/users/by-email/:email', opts, async (request, reply) => {
    const { email } = request.params as { email: string };
    const rows = await prisma.user.findMany({
      where: { email, deletedAt: null },
      include: USER_INCLUDE,
    });
    const ctx = await mapCtx();
    return sendResponse(reply, rows.map((u) => mapUserToRemna(mapUserToPublic(u, u.traffic), ctx)));
  });

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
  app.get('/api/users/:uuid', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const dto = await usersService.getUserById(uuid); // throws UserNotFoundError → 404
    return sendResponse(reply, mapUserToRemna(dto, await mapCtx()));
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

  // POST /api/internal-squads/:uuid/bulk-actions/add-users — membership is a
  // full-set replacement of groupIds on the user; add = read-modify-write.
  // Adding a real squad drops the no-access group (they're mutually exclusive).
  app.post('/api/internal-squads/:uuid/bulk-actions/add-users', opts, async (request, reply) => {
    // Normalise the target the same way as create/PATCH: a case-variant uuid
    // would miss the "already a member" check and then collide on the
    // group_members PK (500), and the system groups are never a valid target.
    const [uuid] = normalizeSquadIds([(request.params as { uuid: string }).uuid]);
    const body = BulkUsersSchema.parse(request.body ?? {});
    const userIds = body.userUuids ?? body.users ?? [];
    for (const userId of userIds) {
      try {
        const dto = await usersService.getUserById(userId);
        const base = realSquadsOf(dto);
        if (uuid && base.includes(uuid)) continue;
        await usersService.updateUser(userId, UpdateUserSchema.parse({ groupIds: [...base, uuid] }));
      } catch (err) {
        if (err instanceof usersService.UserNotFoundError) continue;
        throw err;
      }
    }
    return sendResponse(reply, { affected: userIds.length });
  });

  // DELETE /api/internal-squads/:uuid/bulk-actions/remove-users — removing the
  // last squad drops the user into the no-access group (not the "All" squad).
  app.delete('/api/internal-squads/:uuid/bulk-actions/remove-users', opts, async (request, reply) => {
    const [uuid] = normalizeSquadIds([(request.params as { uuid: string }).uuid]);
    const body = BulkUsersSchema.parse(request.body ?? {});
    const userIds = body.userUuids ?? body.users ?? [];
    for (const userId of userIds) {
      try {
        const dto = await usersService.getUserById(userId);
        if (!dto.groupIds.includes(uuid!)) continue;
        // Drop the removed squad AND any system group, then backstop: losing
        // your last real squad must land in no-access, never in "All".
        const next = realSquadsOf(dto).filter((g) => g !== uuid);
        await usersService.updateUser(
          userId,
          UpdateUserSchema.parse({ groupIds: await withNoAccessFallback(next) }),
        );
      } catch (err) {
        if (err instanceof usersService.UserNotFoundError) continue;
        throw err;
      }
    }
    return sendResponse(reply, { affected: userIds.length });
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

  // ─────────────── System / tools ───────────────

  // happ link encryption — unsupported; a 404 makes the minishop disable the
  // feature (it checks for HTTP 404/410).
  app.post('/api/system/tools/happ/encrypt', opts, async (_request, reply) =>
    reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'happ link encryption is not supported' }),
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

  // GET /api/bandwidth-stats/users/:uuid — no production consumer; cheap real total.
  app.get('/api/bandwidth-stats/users/:uuid', opts, async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const grouped = await prisma.nodeUserUsageHistory.groupBy({
      by: ['nodeId'],
      where: { userId: uuid },
      _sum: { bytesIn: true, bytesOut: true },
    });
    const nodes = grouped.map((g) => ({
      uuid: g.nodeId,
      total: Number(g._sum.bytesIn ?? 0n) + Number(g._sum.bytesOut ?? 0n),
    }));
    return sendResponse(reply, { uuid, total: nodes.reduce((s, n) => s + n.total, 0), nodes });
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

  // ─────────────── HWID devices ───────────────

  // GET /api/hwid/devices/:userUuid — list a user's devices (metadata nullable).
  app.get('/api/hwid/devices/:userUuid', opts, async (request, reply) => {
    const { userUuid } = request.params as { userUuid: string };
    const rows = await hwidService.listUserDevices(userUuid);
    return sendResponse(reply, { devices: rows.map(mapDevice) });
  });

  // POST /api/hwid/devices/delete {userUuid, hwid} — native delete is by row id,
  // so resolve hwid→id. Missing device → idempotent {deleted:false} (200) so the
  // minishop still invalidates its cache instead of showing an error.
  app.post('/api/hwid/devices/delete', opts, async (request, reply) => {
    const body = z.object({ userUuid: z.string(), hwid: z.string().min(1).max(255) }).loose().parse(request.body);
    // Single atomic statement instead of find-then-delete-by-id: the read/write
    // gap let two concurrent deletes of the same device both resolve a row, and
    // the loser's delete-by-id then threw P2025 ("record required but not
    // found") — a 500 for work that was already done. deleteMany is a no-op when
    // the row is gone, so a repeat/concurrent delete is simply {deleted:false}.
    const { count } = await prisma.hwidUserDevice.deleteMany({
      where: { userId: body.userUuid, hwid: body.hwid },
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
