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
  return JSON.stringify({
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
  });
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
 * Fire-and-forget wrapper (best-effort; used for user.expired, where there is no
 * natural retry point). No-ops when unconfigured; never throws into the caller.
 */
export function emitRemnaWebhook(
  name: RemnaWebhookEvent,
  user: RemnaWebhookUser,
  meta: Record<string, unknown> = {},
): void {
  void deliverRemnaWebhook(name, user, meta);
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

  let emitted = 0;
  for (const u of users) {
    if (!u.expireAt) continue;
    const hoursLeft = (u.expireAt.getTime() - nowMs) / 3_600_000;
    const stage = hoursLeft <= 24 ? '24' : hoursLeft <= 48 ? '48' : '72';
    const expireEpochSec = Math.floor(u.expireAt.getTime() / 1000);
    const key = `rw:expnotify:${u.id}:${stage}:${expireEpochSec}`;
    // AT-LEAST-ONCE: skip if already delivered for this (user, stage, cycle),
    // otherwise deliver and claim ONLY on a confirmed 2xx. A failed delivery
    // leaves the key unset so the next hourly tick retries — critical for the
    // terminal 24h stage, which is the minishop's auto-renew CHARGE trigger. The
    // minishop dedups re-sends (24h Redis) and its stale-cycle guard prevents a
    // double-charge, so at-least-once is safe. Key TTL 8d > the 3d window + slack.
    // Cron concurrency is 1 + hourly, so the exists-then-set gap can't race.
    const already = await redis.exists(key).catch(() => 0);
    if (already) continue;
    const ok = await deliverRemnaWebhook(`user.expires_in_${stage}_hours`, u, {});
    if (!ok) continue;
    await redis.set(key, '1', 'EX', 691_200).catch(() => null);
    emitted += 1;
  }
  return emitted;
}
