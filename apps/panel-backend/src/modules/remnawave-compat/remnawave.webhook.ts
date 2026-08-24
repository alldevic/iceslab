import { createHmac } from 'node:crypto';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { redis } from '../../lib/redis.js';
import { getLogger } from '../../lib/logger.js';

/**
 * Remnawave-compat OUTBOUND webhook emitter (panel → minishop). Signs and POSTs
 * Remnawave-shaped lifecycle events to the unmodified minishop's
 * `<WEBHOOK_BASE_URL>/webhook/panel`. Distinct from the native webhook bus
 * (`lib/webhook.ts`) on body shape, signature input (raw body, no timestamp
 * prefix), header name, target and secret — so it's a separate sender. See
 * docs/remnawave-compat.md §4.4.
 */

export interface RemnaWebhookUser {
  id: string;
  telegramId: bigint | null;
  email: string | null;
  expireAt: Date | null;
}

/** Enabled only when the facade is on AND both webhook keys are set. */
export function isRemnaWebhookConfigured(): boolean {
  return (
    config.REMNAWAVE_COMPAT_ENABLED &&
    !!config.REMNAWAVE_COMPAT_WEBHOOK_URL &&
    !!config.REMNAWAVE_COMPAT_WEBHOOK_SECRET
  );
}

/**
 * Every event name this facade is allowed to send.
 *
 * The shop's dispatcher acts only on the names in its own ACTIONABLE_EVENTS set
 * and DROPS anything else without a word (panel_webhook_payloads.py: "elif
 * event_name not in ACTIONABLE_EVENTS"). So a typo, or a name invented here
 * that the shop never learned, is a webhook the panel delivers, the shop
 * answers 200 to, and nobody acts on - a paid renewal that never fires with a
 * successful delivery in our log.
 *
 * Declaring the names as a type is what makes that unrepresentable: the stage
 * template below is checked against this union at compile time, and
 * remnawave.contract.test.ts checks the union against the shop's captured set.
 */
export type RemnaWebhookEvent =
  | `user.expires_in_${'72' | '48' | '24'}_hours`
  | 'user.expired';

/** The same names as a value, for the test that compares them to the shop's. */
export const REMNAWAVE_EMITTED_EVENTS: readonly RemnaWebhookEvent[] = [
  'user.expires_in_72_hours',
  'user.expires_in_48_hours',
  'user.expires_in_24_hours',
  'user.expired',
];

/**
 * Escape every code unit above ASCII as `\uXXXX`.
 *
 * The signature is HMAC over the raw body, so the shop's check passes only if
 * the bytes it reads are the bytes we signed - and between us there is whatever
 * reverse proxy, WAF or CDN the operator runs. A body that is pure ASCII cannot
 * be changed by anything that re-encodes character sets, which is the one
 * mutation of this class that happens quietly rather than loudly. JSON escapes
 * are not a dialect: any parser recombines them, surrogate pairs included, so
 * the shop reads exactly the same string either way.
 *
 * Only `email` can carry non-ASCII today (uuid, telegramId and expireAt cannot),
 * which is precisely why this is worth doing pre-emptively: the failure would
 * appear for one subscriber with an accented address, as a 401 on their expiry
 * webhook, and nowhere else.
 */
function escapeNonAscii(json: string): string {
  // eslint-disable-next-line no-control-regex
  return json.replace(/[^\x00-\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Build the exact JSON string the minishop parses: `{name, payload:{user}, meta}`.
 * telegramId is coerced BigInt→Number (a bare JSON.stringify throws on bigint;
 * Telegram ids are within JS safe-integer range — same as mapUserToRemna). The
 * returned string is signed AS-IS so the signed bytes equal the sent bytes.
 */
export function buildRemnaWebhookBody(
  name: RemnaWebhookEvent,
  user: RemnaWebhookUser,
  meta: Record<string, unknown> = {},
): string {
  return escapeNonAscii(JSON.stringify({
    name,
    payload: {
      user: {
        uuid: user.id,
        telegramId: user.telegramId != null ? Number(user.telegramId) : null,
        email: user.email ?? null,
        expireAt: user.expireAt ? user.expireAt.toISOString() : null,
      },
    },
    meta,
  }));
}

/**
 * Deliver one signed webhook and AWAIT the outcome — returns true only on a 2xx,
 * false when unconfigured or on any transport/non-2xx error. Never throws.
 * Signature = HMAC-SHA256 hex over the exact raw body sent — matches the
 * minishop's `hmac.new(secret, raw_body, sha256)`.
 */
export async function deliverRemnaWebhook(
  name: RemnaWebhookEvent,
  user: RemnaWebhookUser,
  meta: Record<string, unknown> = {},
): Promise<boolean> {
  const url = config.REMNAWAVE_COMPAT_WEBHOOK_URL;
  const secret = config.REMNAWAVE_COMPAT_WEBHOOK_SECRET;
  if (!config.REMNAWAVE_COMPAT_ENABLED || !url || !secret) return false;

  const body = buildRemnaWebhookBody(name, user, meta);
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Remnawave-Signature': signature },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      getLogger().warn({ status: res.status, event: name }, '[remnawave-webhook] non-2xx from minishop');
      return false;
    }
    return true;
  } catch (err: unknown) {
    getLogger().warn({ err, event: name }, '[remnawave-webhook] delivery failed');
    return false;
  }
}

/**
 * Bounded fan-out for everything this module sends.
 *
 * The emitters are called one per user, and the callers are batch jobs: one
 * expiry tick flips every user whose term ended in the last ten minutes, and at
 * a month boundary that is the whole cohort at once. Unbounded, that is one
 * simultaneous socket per user pointed at a shop whose own inbound cap is 50
 * concurrent handlers, and there is no retry behind `user.expired`.
 *
 * What it is NOT for, measured rather than assumed: the database. Prisma
 * releases the connection when the row read completes, before the POST, so 300
 * unbounded deliveries produced no pool error and moved an unrelated query from
 * 16ms to 50ms. An earlier version of this comment claimed pool exhaustion; it
 * was wrong.
 *
 * A semaphore turns the stampede into a queue. It does not make the work
 * smaller - a slow shop still takes as long - but nothing arrives all at once,
 * and the limit is set against the shop's cap rather than against a guess.
 */
let inFlight = 0;
const waiting: (() => void)[] = [];

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  inFlight -= 1;
}

/** Run `task` once a delivery slot is free. Slots are handed out in FIFO order. */
export async function withWebhookSlot<T>(task: () => Promise<T>): Promise<T> {
  const limit = config.REMNAWAVE_COMPAT_WEBHOOK_CONCURRENCY;
  if (inFlight >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    inFlight += 1;
  }
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

/** In-flight + queued deliveries; for tests and for a future metric. */
export function remnaWebhookQueueDepth(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiting.length };
}

/**
 * Fire-and-forget delivery for one user, best-effort: used for `user.expired`,
 * where there is no natural retry point. No-ops when unconfigured; never throws
 * into the caller.
 *
 * The row is resolved by id INSIDE the slot, and the caller passes only the id.
 * That is the whole point when the caller is a batch: a handler that reads the
 * row first and only then queues the send has already opened one Prisma
 * connection per user before the semaphore ever sees them, so the pool is
 * exhausted by the very code meant to protect it. There is deliberately no
 * second entry point taking an already-loaded row - the second copy is where
 * the two would drift.
 */
export function emitRemnaWebhookForUser(
  name: RemnaWebhookEvent,
  userId: string,
  meta: Record<string, unknown> = {},
): void {
  if (!isRemnaWebhookConfigured()) return;
  void withWebhookSlot(async () => {
    try {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, telegramId: true, email: true, expireAt: true },
      });
      if (!row) return; // raced a hard delete
      await deliverRemnaWebhook(name, row, meta);
    } catch (err: unknown) {
      getLogger().warn({ err, event: name, userId }, '[remnawave-webhook] could not load the user to notify about');
    }
  });
}

/**
 * Cron scan: emit `user.expires_in_{72,48,24}_hours` for active users whose
 * subscription lapses within 72h. Each (user, stage, expiry-cycle) fires once —
 * Redis `SET NX` dedup keyed on the exact expireAt, so a renewal (new expireAt)
 * re-arms the notifications for the new cycle. Returns the number emitted.
 */
export async function scanRemnaExpiryNotifications(): Promise<number> {
  if (!isRemnaWebhookConfigured()) return 0;

  const nowMs = Date.now();
  const users = await prisma.user.findMany({
    where: {
      // 'expires-soon' is a TIME concept, orthogonal to the traffic cap. A user
      // who burned their quota is 'limited' (off nodes) but their subscription
      // WINDOW is still closing — and the 24h stage is the minishop's sole
      // auto-renew CHARGE trigger. Scanning only 'active' would silently starve
      // auto-renew for every capped-out period subscriber (charge never fires,
      // sub lapses despite a working saved method). Include 'limited'; keep
      // excluding 'disabled' (admin-off) and 'expired' (already lapsed).
      status: { in: ['active', 'limited'] },
      deletedAt: null,
      expireAt: { gt: new Date(nowMs), lte: new Date(nowMs + 72 * 3_600_000) },
    },
    select: { id: true, telegramId: true, email: true, expireAt: true },
  });

  // The dedup read is ONE round trip for the whole cohort, not one per user.
  // This runs every ten minutes and most ticks have nothing to send, so the
  // cost of the tick is the cost of finding that out: an indexed query and an
  // MGET. Per-user EXISTS made that N round trips, which is what made an hourly
  // cadence feel necessary - and an hourly cadence is what leaves a term
  // shorter than an hour with no charge trigger at all.
  const staged = users
    .map((u) => stageFor(u, nowMs))
    .filter((s): s is StagedNotification => s !== null);
  if (staged.length === 0) return 0;
  const claimed = await redis.mget(staged.map((s) => s.key)).catch(() => null);
  const pending = claimed ? staged.filter((_, i) => claimed[i] === null) : staged;
  if (pending.length === 0) return 0;

  // Through the same slots as everything else. Sequentially this loop was
  // bounded at one delivery at a time, which is safe and, for a cohort of
  // thousands at a five-second timeout apiece, slower than the gap between
  // ticks - a 24h stage that misses its window is a charge that never fires.
  const sent = await Promise.all(pending.map((s) => withWebhookSlot(() => notifyOne(s))));
  return sent.reduce<number>((acc, n) => acc + n, 0);
}

interface StagedNotification {
  user: RemnaWebhookUser;
  stage: '72' | '48' | '24';
  key: string;
}

/** Which stage this user is in, and the (user, stage, cycle) key that claims it. */
function stageFor(u: RemnaWebhookUser, nowMs: number): StagedNotification | null {
  if (!u.expireAt) return null;
  const hoursLeft = (u.expireAt.getTime() - nowMs) / 3_600_000;
  const stage = hoursLeft <= 24 ? '24' : hoursLeft <= 48 ? '48' : '72';
  const expireEpochSec = Math.floor(u.expireAt.getTime() / 1000);
  return { user: u, stage, key: `rw:expnotify:${u.id}:${stage}:${expireEpochSec}` };
}

/** One user's expiry notification: 1 if it was delivered and claimed, else 0. */
async function notifyOne(s: StagedNotification): Promise<number> {
  // AT-LEAST-ONCE: deliver and claim ONLY on a confirmed 2xx. A failed delivery
  // leaves the key unset so the next tick retries — critical for the terminal
  // 24h stage, which is the minishop's auto-renew CHARGE trigger. The minishop
  // dedups re-sends and its stale-cycle guard prevents a double-charge, so
  // at-least-once is safe. Key TTL 8d > the 3d window + slack. Cron concurrency
  // is 1 and the key is per (user, stage, cycle), so running the scan's users
  // concurrently does not put two writers on one key.
  const ok = await deliverRemnaWebhook(`user.expires_in_${s.stage}_hours`, s.user, {});
  if (!ok) return 0;
  await redis.set(s.key, '1', 'EX', 691_200).catch(() => null);
  return 1;
}
