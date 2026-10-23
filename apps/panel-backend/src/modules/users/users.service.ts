import type { Prisma } from '../../generated/prisma/client.js';
import { generateUserCredentials, generateSubscriptionToken } from '../../lib/auth/credentials.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { ALL_SQUAD_ID } from '../squads/squads.constants.js';
import { ensureAllSquad } from '../squads/squads.system.js';
import * as repo from './users.repository.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
  BulkUsersInput,
  UserStatus as UserStatusSchema,
} from './users.schemas.js';
import type { z } from 'zod';

type UserStatus = z.infer<typeof UserStatusSchema>;
import { mapUserToPublic, type PublicUserDto } from './users.mapper.js';
import { assertCustomPresetExists, presetUpdateData } from '../routing-presets/routing-presets.assign.js';

// ───── Domain errors ─────

export class UserAlreadyExistsError extends Error {
  constructor(public username: string) {
    super(`User "${username}" already exists`);
    this.name = 'UserAlreadyExistsError';
  }
}

export class UserNotFoundError extends Error {
  constructor(public id: string) {
    super(`User ${id} not found`);
    this.name = 'UserNotFoundError';
  }
}

export class SubscriptionTokenTakenError extends Error {
  constructor(public token: string) {
    super('Subscription token already in use');
    this.name = 'SubscriptionTokenTakenError';
  }
}

// ───── Helpers ─────

const BYTES_PER_GB = 1_073_741_824n;

function gbToBytes(gb: number | null | undefined): bigint | null {
  return gb != null ? BigInt(gb) * BYTES_PER_GB : null;
}

function daysFromNow(days: number | null | undefined): Date | null {
  return days != null ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
}

function toBigIntOrNull(value: number | string | null | undefined): bigint | null {
  return value != null ? BigInt(value) : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

/** The columns or constraint a P2002 names (`meta.target`: a list of fields,
 *  or the constraint's name), as strings; empty when it names none. */
function uniqueTargetNames(err: unknown): string[] {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.map(String);
  return typeof target === 'string' ? [target] : [];
}

// ───── Service methods ─────

export async function createUser(input: CreateUserInput): Promise<PublicUserDto> {
  const existing = await repo.findActiveByUsername(input.username);
  if (existing) {
    throw new UserAlreadyExistsError(input.username);
  }

  // Optional sub-token import (migration cut-over): reject up front if the
  // requested token is already taken, so the caller gets a clear 409 instead
  // of an ambiguous P2002.
  if (input.subscriptionToken) {
    const tokenClash = await repo.findBySubscriptionToken(input.subscriptionToken);
    if (tokenClash) {
      throw new SubscriptionTokenTakenError(input.subscriptionToken);
    }
  }

  await assertCustomPresetExists(input.customRoutingPresetId);

  const creds = generateUserCredentials();

  let user;
  try {
    // A user with no squad picked lands in the system "All" squad, and on a
    // database that lost that row (dev, 2026-09-23) the membership failed on a
    // foreign key. The row is repaired in the same transaction; membership of
    // anybody else is not touched. Explicit squads need no repair.
    const intoAll = input.groupIds.length === 0;
    user = await repo.create({
      username: input.username,
      shortId: creds.shortId,
      subscriptionToken: input.subscriptionToken ?? creds.subscriptionToken,

      hysteriaPassword:    creds.hysteriaPassword,
      naivePassword:       creds.naivePassword,
      // Import: carry the user's existing VLESS identity so their current link
      // keeps working. Anything not supplied is freshly generated as before.
      xrayUuid:            input.vlessUuid ?? creds.xrayUuid,
      amneziawgPrivateKey: creds.amneziawgPrivateKey,
      amneziawgPublicKey:  creds.amneziawgPublicKey,

      trafficLimitBytes:    gbToBytes(input.trafficLimitGb),
      trafficLimitStrategy: input.trafficLimitStrategy,
      // An absolute instant wins over a relative span: expireAt is a fact being
      // transferred from another panel, expireDays is a convenience for humans
      // creating a user by hand.
      expireAt:             input.expireAt ? new Date(input.expireAt) : daysFromNow(input.expireDays),
      // Registration date from the source panel; without it a three-year
      // customer reads as "registered today" and every other number on the page
      // loses credibility.
      ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
      // Provenance: what makes a second import run a delta instead of a
      // duplicate. Never set for a user created by hand.
      sourceId:             input.sourceId ?? null,

      hwidDeviceLimit: input.hwidDeviceLimit ?? null,
      // R3 - per-user routing override; null = inherit (squad -> global -> default).
      routingPreset:   input.routingPreset ?? null,
      // A-229 - or an own preset (the schema refused both at once).
      ...(input.customRoutingPresetId
        ? { customRoutingPreset: { connect: { id: input.customRoutingPresetId } } }
        : {}),
      description:     input.description ?? null,
      tag:             input.tag ?? null,
      telegramId:      toBigIntOrNull(input.telegramId),
      email:           input.email ?? null,

      enabledProtocols: input.enabledProtocols,

      traffic: { create: {} },
      groupMembers: {
        // When admin doesn't pick any squads explicitly, drop the user into
        // the seeded "All" squad: it grants visibility of every inbound and
        // matches pre-slice-26 behaviour. Slice 26 invariant: every user is in
        // at least one group, otherwise their subscription would be empty.
        create: (input.groupIds.length > 0 ? input.groupIds : [ALL_SQUAD_ID]).map(
          (groupId) => ({ groupId }),
        ),
      },
    }, intoAll ? ensureAllSquad : undefined);
  } catch (err) {
    // Map a DB-level UNIQUE violation on the partial index
    // (users_username_active_key, WHERE deleted_at IS NULL) back to the
    // friendly 409. The findActiveByUsername check above is check-then-insert,
    // so two concurrent creates can both pass it and race on the INSERT; the
    // loser surfaces here as P2002 instead of a raw 500. Mirrors
    // nodes.service.ts createNode.
    if (isUniqueViolation(err)) {
      // The race can be lost on the imported token as well (A-210): say which.
      if (input.subscriptionToken && uniqueTargetNames(err).some((t) => /subscription_?token/i.test(t))) {
        throw new SubscriptionTokenTakenError(input.subscriptionToken);
      }
      throw new UserAlreadyExistsError(input.username);
    }
    throw err;
  }

  eventBus.emit('user.created', {
    userId: user.id,
    username: user.username,
  });

  return mapUserToPublic(user, user.traffic);
}

export async function listUsers(query: ListUsersQuery): Promise<{
  users: PublicUserDto[];
  total: number;
  page: number;
  limit: number;
}> {
  const { users, total } = await repo.list(query);
  return {
    users: users.map((u) => mapUserToPublic(u, u.traffic)),
    total,
    page: query.page,
    limit: query.limit,
  };
}

export async function getUserById(id: string): Promise<PublicUserDto> {
  const user = await repo.findActiveById(id);
  if (!user) {
    throw new UserNotFoundError(id);
  }
  return mapUserToPublic(user, user.traffic);
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
): Promise<PublicUserDto> {
  const existing = await repo.findActiveById(id);
  if (!existing) {
    throw new UserNotFoundError(id);
  }

  // Unchecked: the preset pair is written as two scalar columns in ONE UPDATE.
  // A relation `disconnect` runs as its own statement after the scalars, and
  // in between the row would hold both, which the CHECK refuses.
  const data: Prisma.UserUncheckedUpdateInput = {};
  const changedFields: string[] = [];

  const nextStatus = statusAfterEdit(existing, input);
  if (nextStatus !== undefined) {
    data.status = nextStatus;
    changedFields.push('status');
  }
  if (input.trafficLimitGb !== undefined) {
    data.trafficLimitBytes = gbToBytes(input.trafficLimitGb);
    changedFields.push('trafficLimitBytes');
  }
  if (input.trafficLimitStrategy !== undefined) {
    data.trafficLimitStrategy = input.trafficLimitStrategy;
    changedFields.push('trafficLimitStrategy');
  }
  if (input.expireAt !== undefined) {
    data.expireAt = input.expireAt ? new Date(input.expireAt) : null;
    changedFields.push('expireAt');
  }
  if (input.hwidDeviceLimit !== undefined) {
    data.hwidDeviceLimit = input.hwidDeviceLimit;
    changedFields.push('hwidDeviceLimit');
  }
  // R3 + A-229: the preset choice, a built-in key or an own preset, never both.
  // A value written to one side clears the other; null clears only its own
  // side (back to inherit squad -> global -> default); an absent key is no edit.
  const preset = presetUpdateData(input);
  if (preset.customRoutingPresetId) await assertCustomPresetExists(preset.customRoutingPresetId);
  if (preset.routingPreset !== undefined) {
    data.routingPreset = preset.routingPreset;
    if (input.routingPreset !== undefined || existing.routingPreset !== null) changedFields.push('routingPreset');
  }
  if (preset.customRoutingPresetId !== undefined) {
    data.customRoutingPresetId = preset.customRoutingPresetId;
    if (input.customRoutingPresetId !== undefined || existing.customRoutingPresetId !== null) {
      changedFields.push('customRoutingPresetId');
    }
  }
  if (input.description !== undefined) {
    data.description = input.description;
    changedFields.push('description');
  }
  if (input.tag !== undefined) {
    data.tag = input.tag;
    changedFields.push('tag');
  }
  if (input.telegramId !== undefined) {
    data.telegramId = toBigIntOrNull(input.telegramId);
    changedFields.push('telegramId');
  }
  if (input.email !== undefined) {
    data.email = input.email;
    changedFields.push('email');
  }
  if (input.groupIds !== undefined) {
    // Mirror createUser's fallback: an empty groupIds means "no squads picked",
    // but deleteMany + create:[] would leave the user in zero groups and their
    // subscription silently empty. Slice 26 invariant: every user is in at
    // least one group, so fall back to the seeded "All" squad here too.
    const groupIds = input.groupIds.length > 0 ? input.groupIds : [ALL_SQUAD_ID];
    data.groupMembers = {
      deleteMany: {},
      create: groupIds.map((groupId) => ({ groupId })),
    };
    changedFields.push('groupIds');
  }
  if (input.enabledProtocols !== undefined) {
    data.enabledProtocols = input.enabledProtocols;
    changedFields.push('enabledProtocols');
  }

  // The same repair as on create: falling back to "All" on a database that
  // lost the row would fail on the foreign key.
  const intoAll = input.groupIds !== undefined && input.groupIds.length === 0;
  const updated = await repo.updateById(id, data, intoAll ? ensureAllSquad : undefined);

  if (changedFields.length > 0) {
    eventBus.emit('user.updated', {
      userId: id,
      changes: changedFields,
    });
  }

  // Status transition is a separate, more specific event
  if (nextStatus && nextStatus !== existing.status) {
    eventBus.emit('user.status-changed', {
      userId: id,
      from: existing.status,
      to: nextStatus,
    });
  }

  return mapUserToPublic(updated, updated.traffic);
}

/**
 * The status an edit leaves the user in, or undefined for no change.
 *
 * A-048. The status changed only when the input named one, so an extension
 * (form, bulk extend, API) moved the date into the future and left the user
 * `expired`: the subscription kept refusing and the crons never bring anyone
 * back, they only pick active users. The same for a quota raised above what
 * a `limited` user has used. Now an edit that clears the reason brings the
 * user back by itself, the date or the quota alone is enough.
 *
 * And the other half (A-060, server side). `active` asked for a user whose
 * date has still passed, or whose quota is still spent, is not active: the
 * crons would flip it back within a minute, after the user had been rolled
 * out to every node and taken off again. The screen sends `active` with any
 * edit of an expired user, so that loop ran on a description change. Such a
 * request lands on the status the facts give.
 *
 * `disabled` is the operator's word and is taken as said, both ways in.
 */
export function statusAfterEdit(
  existing: {
    status: string;
    expireAt: Date | null;
    trafficLimitBytes: bigint | null;
    traffic?: { usedTrafficBytes: bigint } | null;
  },
  input: Pick<UpdateUserInput, 'status' | 'expireAt' | 'trafficLimitGb'>,
  now: Date = new Date(),
): UserStatus | undefined {
  const expireAt =
    input.expireAt !== undefined ? (input.expireAt ? new Date(input.expireAt) : null) : existing.expireAt;
  const limit = input.trafficLimitGb !== undefined ? gbToBytes(input.trafficLimitGb) : existing.trafficLimitBytes;
  const used = existing.traffic?.usedTrafficBytes ?? 0n;
  const byFacts = (): UserStatus =>
    expireAt && expireAt < now ? 'expired' : limit !== null && used >= limit ? 'limited' : 'active';

  if (input.status === 'disabled') return 'disabled';
  if (input.status === 'active') return byFacts();
  if (input.status !== undefined) return input.status;
  // Nothing asked: only a user held back by the date or the quota moves, and
  // only when this edit touched what holds them.
  const touched =
    (existing.status === 'expired' && input.expireAt !== undefined) ||
    (existing.status === 'limited' && input.trafficLimitGb !== undefined);
  if (!touched) return undefined;
  const next = byFacts();
  return next === existing.status ? undefined : next;
}

export interface BulkResult {
  ok: string[];
  failed: { userId: string; error: string }[];
}

/**
 * Apply one action to many users.
 *
 * Deliberately built ON TOP of the single-user functions rather than as a set
 * of bulk SQL statements. Those functions carry more than a database write:
 * they emit the domain events that push the change to nodes, invalidate the
 * subscription caches and feed the audit trail. A hand-written `updateMany`
 * would be faster and would silently skip all of it, so "reset 300 users" would
 * behave differently from resetting 300 users one at a time - the kind of
 * divergence nobody notices until traffic accounting disagrees with reality.
 *
 * The cost is N round trips. Accepted: bulk jobs run on hundreds, not on the
 * whole roster, and the migration path uses the importer, not this endpoint.
 *
 * Partial failure is normal and reported per user rather than rolled back: if
 * three of two hundred ids are already deleted, the operator wants the other
 * hundred and ninety-seven done, plus a list of which three to look at.
 */
export async function bulkUsers(input: BulkUsersInput): Promise<BulkResult> {
  const result: BulkResult = { ok: [], failed: [] };
  for (const userId of input.userIds) {
    try {
      switch (input.action) {
        case 'extend': {
          const current = await repo.findActiveById(userId);
          if (!current) throw new UserNotFoundError(userId);
          // Extend from the CURRENT expiry when it is still in the future, so
          // renewing early does not quietly shorten a subscription; from now
          // when it has already lapsed.
          const base =
            current.expireAt && current.expireAt > new Date() ? current.expireAt : new Date();
          const expireAt = new Date(base.getTime() + input.expireDays! * 24 * 60 * 60 * 1000);
          await updateUser(userId, { expireAt: expireAt.toISOString() });
          break;
        }
        case 'reset-traffic':
          await resetUserTraffic(userId);
          break;
        case 'revoke':
          await revokeSubscription(userId);
          break;
        case 'delete':
          await deleteUser(userId);
          break;
        case 'enable':
          await updateUser(userId, { status: 'active' });
          break;
        case 'disable':
          await updateUser(userId, { status: 'disabled' });
          break;
      }
      result.ok.push(userId);
    } catch (err) {
      result.failed.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export async function deleteUser(id: string): Promise<void> {
  const exists = await repo.existsActive(id);
  if (!exists) {
    throw new UserNotFoundError(id);
  }

  await repo.softDelete(id);

  eventBus.emit('user.deleted', { userId: id });
}

// ───── Subscription revoke / rotate (production-readiness) ─────

/**
 * Revoke the user's current subscription link: stamp subRevokedAt so
 * /sub/:token returns 403 REVOKED. Does not disconnect live sessions (kills
 * the link, not the creds); rotate to hand out a working link again.
 */
export async function revokeSubscription(id: string): Promise<PublicUserDto> {
  const existing = await repo.findActiveById(id);
  if (!existing) {
    throw new UserNotFoundError(id);
  }
  const updated = await repo.updateById(id, { subRevokedAt: new Date() });
  eventBus.emit('user.updated', { userId: id, changes: ['subRevokedAt'] });
  return mapUserToPublic(updated, updated.traffic);
}

/**
 * Rotate the subscription token: the old link stops resolving (no user matches
 * it -> /sub 404) and any prior revoke is cleared so the new link is live.
 */
export async function rotateSubscription(id: string): Promise<PublicUserDto> {
  const existing = await repo.findActiveById(id);
  if (!existing) {
    throw new UserNotFoundError(id);
  }
  // Token is 32 random bytes; a unique collision is astronomically unlikely,
  // but retry on the off chance rather than surfacing a raw 500.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const updated = await repo.updateById(id, {
        subscriptionToken: generateSubscriptionToken(),
        subRevokedAt: null,
      });
      eventBus.emit('user.updated', {
        userId: id,
        changes: ['subscriptionToken', 'subRevokedAt'],
      });
      return mapUserToPublic(updated, updated.traffic);
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error('Failed to rotate subscription token after retries');
}

/**
 * On-demand traffic reset (period-billing top-up): zero usedTrafficBytes and
 * stamp lastTrafficResetAt, then emit user.traffic-reset. The existing handler
 * (users.events.ts) lifts a traffic limit (limited -> active) and re-provisions
 * nodes - same cascade the cron strategy reset uses.
 */
export async function resetUserTraffic(id: string): Promise<PublicUserDto> {
  const existing = await repo.findActiveById(id);
  if (!existing) {
    throw new UserNotFoundError(id);
  }
  const previousUsedBytes = existing.traffic?.usedTrafficBytes ?? 0n;
  await repo.resetTraffic(id);
  eventBus.emit('user.traffic-reset', { userId: id, previousUsedBytes });
  const refreshed = await repo.findActiveById(id);
  return mapUserToPublic(refreshed ?? existing, refreshed?.traffic ?? null);
}