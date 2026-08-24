import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  UserAlreadyExistsError,
  UserNotFoundError,
  SubscriptionTokenTakenError,
} from '../users/users.service.js';
import { SquadNotFoundError } from '../squads/squads.service.js';

/**
 * A deliberate Remnawave-style error the facade can throw to return a specific
 * errorCode + HTTP status (e.g. A062 "not found → empty" for the by-* lookups).
 */
export class RemnaError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemnaError';
  }
}

/**
 * Every successful facade response is `{"response": <payload>}` with an
 * application/json content-type — the minishop client keeps a 2xx body only
 * when both hold, and reads the payload from the top-level `response` key.
 */
export function sendResponse(
  reply: FastifyReply,
  payload: unknown,
  status = 200,
): FastifyReply {
  return reply.code(status).send({ response: payload });
}

/**
 * Facade-scoped error handler → Remnawave `{errorCode, message}` shape. The
 * minishop branches on `errorCode`/`code` (top-level or under `details`) plus
 * the HTTP status, so the codes below are load-bearing:
 *   - A019 → username already exists (client re-fetches by username)
 *   - A062 → not found (client returns an empty list for by-* lookups)
 *   - 404 / NOT_FOUND → user/squad not found
 *   - VALIDATION_ERROR_USERNAME → invalid username format
 */
export function remnawaveErrorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof RemnaError) {
    return reply.code(error.status).send({ errorCode: error.code, message: error.message });
  }
  if (error instanceof ZodError) {
    const usernameIssue = error.issues.some((i) => i.path.includes('username'));
    return reply.code(400).send({
      errorCode: usernameIssue ? 'VALIDATION_ERROR_USERNAME' : 'VALIDATION_ERROR',
      message: 'Invalid input',
    });
  }
  if (error instanceof UserAlreadyExistsError || error instanceof SubscriptionTokenTakenError) {
    return reply.code(409).send({ errorCode: 'A019', message: error.message });
  }
  if (error instanceof UserNotFoundError || error instanceof SquadNotFoundError) {
    return reply.code(404).send({ errorCode: 'NOT_FOUND', message: error.message });
  }
  // A malformed id (non-UUID string reaching a Postgres @db.Uuid filter) throws
  // a Prisma known-request error — P2007 (data validation) under the pg driver
  // adapter this project uses, P2023 (inconsistent column data) under the Rust
  // engine, depending on version; an over-length value throws P2000. The shop
  // only ever sends panel-assigned UUIDs, but a leaked token or a corrupt/
  // legacy/imported id would otherwise fall through to a 500 — which the shop
  // reads as a lookup FAILURE (not a 404), so it can never clean up / reconcile
  // that id. Map them to the Remnawave-contract shapes: a bad id is "not found",
  // an oversize value is a validation error. (Duck-typed on `.code`, like
  // users.service P2002; both codes handled so it is adapter/version-robust.)
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'P2007' || code === 'P2023') {
      return reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'not found' });
    }
    if (code === 'P2003') {
      // FK violation. In the facade the only user-reachable FK is a squad (group)
      // reference in activeInternalSquads/groupIds pointing at a group that does
      // not exist on THIS panel — the shop sends operator-configured squad uuids
      // (USER_SQUAD_UUIDS / tariff squads) that can be stale, typo'd, or from a
      // different panel. Left unmapped this was a 500 (the shop treats 5xx as a
      // retryable outage and hammers, while a paid activation is reported failed);
      // return a definitive 400 so the shop fails cleanly and the operator sees a
      // validation error, not INTERNAL_ERROR. The offending write is a single
      // nested create/update, so it rolls back atomically — no partial state.
      return reply.code(400).send({ errorCode: 'VALIDATION_ERROR', message: 'referenced squad does not exist' });
    }
    if (code === 'P2025') {
      // "record required but not found" — e.g. two concurrent deletes of the
      // same row: the loser must not see a 500 for work that is already done.
      return reply.code(404).send({ errorCode: 'NOT_FOUND', message: 'not found' });
    }
    if (code === 'P2000' || code === 'P2020') {
      // value too long / out of range for the column
      return reply.code(400).send({ errorCode: 'VALIDATION_ERROR', message: 'Invalid input' });
    }
  }
  // Framework-level 4xx (Fastify/plugins): rate limit (429), malformed body,
  // unsupported media type, etc. These carry an HTTP statusCode and are NOT
  // server faults — passing them through as 500 made the shop treat a rate-limit
  // rejection as a retryable outage and hammer, while a paid activation was
  // reported failed. Preserve the status, re-shape the body to the Remnawave
  // contract. (Any Retry-After / X-RateLimit-* headers the plugin already set on
  // the reply are preserved.)
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({
      errorCode: statusCode === 429 ? 'RATE_LIMITED' : 'VALIDATION_ERROR',
      message:
        statusCode === 429 ? 'Rate limit exceeded' : ((error as Error)?.message ?? 'Invalid request'),
    });
  }
  request.log.error({ err: error }, 'remnawave-compat unhandled error');
  return reply.code(500).send({ errorCode: 'INTERNAL_ERROR', message: 'Internal server error' });
}
