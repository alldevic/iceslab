import { Queue, Worker, type Job } from 'bullmq';
import { redis } from '../../lib/redis.js';
import {
  resetTrafficForStrategy,
  resetTrafficRolling,
  findExpiredUsers,
  findExceededTrafficUsers,
  reconcileOrphanNodeUsers,
  alertNearLimits,
} from '../users/users.cron.js';
import { pollNodeStatuses, pollNodeMetrics } from '../nodes/nodes.cron.js';
import { pollNodeStats } from '../stats/stats.cron.js';
import { pruneHistory } from '../maintenance/retention.cron.js';
import { refreshGeoAndRepush } from '../geo/geo.cron.js';
import { config } from '../../config.js';
import { scanRemnaExpiryNotifications } from '../remnawave-compat/remnawave.webhook.js';
import { getLogger } from '../../lib/logger.js';

// ───── Queue ─────

const QUEUE_NAME = 'cron-tasks';

// Cron-задачи без полезной нагрузки, имя джоба сам себе данные.
export const cronTasksQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400 },
  },
});

// ───── Job names + расписание (зеркалим Remnawave) ─────

interface CronJobSpec {
  name: string;
  pattern: string; // cron-выражение
}

const CRON_JOBS: CronJobSpec[] = [
  { name: 'reset-traffic-daily',            pattern: '5 0 * * *'  }, // 00:05 каждый день
  { name: 'reset-traffic-monthly-rolling',  pattern: '10 0 * * *' }, // 00:10 каждый день (rolling 30d)
  { name: 'reset-traffic-weekly',           pattern: '15 0 * * 1' }, // понедельник 00:15
  { name: 'reset-traffic-monthly',          pattern: '20 0 1 * *' }, // 1-е число 00:20
  { name: 'review-find-expired',            pattern: '*/30 * * * * *' }, // каждые 30 секунд
  { name: 'review-find-exceeded-traffic',   pattern: '*/45 * * * * *' }, // каждые 45 секунд
  { name: 'node-healthcheck-poll',          pattern: '*/30 * * * * *' }, // каждые 30 секунд
  { name: 'node-metrics-poll',              pattern: '*/15 * * * * *' }, // каждые 15 секунд
  { name: 'node-stats-poll',                pattern: '*/30 * * * * *' }, // каждые 30 секунд - per-user/per-node traffic
  { name: 'reconcile-orphan-users',         pattern: '*/10 * * * *' },   // каждые 10 минут - catch-up for status-flip crashes / dropped jobs
  { name: 'prune-history',                  pattern: '30 3 * * *' },     // 03:30 каждый день - B2 retention для append-only history-таблиц
  { name: 'geo-rebuild',                    pattern: '40 * * * *' },     // :40 каждый час - re-check sources DUE per their refreshIntervalHours (conditional GET/ETag), rebuild + re-push only on real change
  { name: 'alert-near-expiry',              pattern: '0 9 * * *'  },     // 09:00 каждый день - K3 near-expiry/near-cap дайджест в Telegram
  // Каждые 10 минут, не раз в час. 24h-стадия - единственный триггер
  // авто-списания у витрины, и при часовом такте подписка с сроком короче часа
  // может истечь между двумя тактами, ни разу не попав в окно: списания не
  // будет, а выглядеть это будет как отказ клиента платить. Такт стоит один
  // индексированный запрос и один MGET (дедуп читается пачкой), поэтому
  // учащение почти бесплатно; побочно 24h-вебхук уходит в пределах 10 минут от
  // границы, а не 60.
  { name: 'remnawave-expiry-notify',        pattern: '*/10 * * * *' },   // каждые 10 минут - Remnawave-compat expires-in-{72,48,24}h вебхуки (no-op если фасад/вебхук выкл)
];

// ───── Регистрация (вызывается один раз при бутстрапе) ─────

/**
 * Which of the schedules already in Redis no longer belong to the current
 * CRON_JOBS list, and must be removed.
 *
 * `jobId` does NOT make a schedule replaceable: BullMQ keys a job scheduler by
 * name AND repeat options, so changing a pattern registers a SECOND schedule
 * and leaves the first one running. Measured on the lab panel, which had
 * `remnawave-expiry-notify` on both the old hourly pattern and the new
 * ten-minute one, and `geo-rebuild` on two patterns at once - the latter while
 * `GEO_SELF_HOST=false` meant the code was not registering it at all. A filter
 * in the code loses to state in Redis.
 *
 * Mostly that is extra load, and for the expiry scan specifically it is
 * harmless (the dedup makes an extra tick free). It stops being harmless the
 * moment a pattern is turned DOWN because something was too frequent, or a job
 * is deleted from the list: the old schedule keeps firing either way, and in
 * the second case at a handler that no longer exists.
 *
 * Pure, so it can be tested without touching a queue - and the queue in
 * question is shared with a running panel, which is not a thing to write tests
 * against.
 */
export function staleScheduleIds(
  existing: readonly { key?: string; name?: string; pattern?: string | null }[],
  desired: readonly CronJobSpec[],
): string[] {
  const wanted = new Set(desired.map((j) => `${j.name}\u0000${j.pattern}`));
  return existing
    .filter((s) => s.key && !wanted.has(`${s.name ?? ''}\u0000${s.pattern ?? ''}`))
    .map((s) => s.key as string);
}

export async function registerCronJobs(): Promise<void> {
  // The geo refresh only makes sense when self-hosting is on (otherwise there is
  // no build to refresh and nothing to push).
  const jobs = config.GEO_SELF_HOST
    ? CRON_JOBS
    : CRON_JOBS.filter((j) => j.name !== 'geo-rebuild');

  // Drop whatever is scheduled and no longer wanted BEFORE adding, so a pattern
  // change replaces rather than accumulates. This is also what makes the
  // geo-rebuild filter above mean anything: without it, a schedule left from a
  // prior GEO_SELF_HOST=true run keeps firing regardless of the setting.
  const stale = staleScheduleIds(await cronTasksQueue.getJobSchedulers(0, 1000), jobs);
  for (const id of stale) {
    await cronTasksQueue.removeJobScheduler(id);
  }
  if (stale.length > 0) {
    getLogger().info(`[scheduler] removed ${stale.length} stale schedule(s)`);
  }

  for (const job of jobs) {
    await cronTasksQueue.add(
      job.name,
      {},
      {
        repeat: { pattern: job.pattern },
        // jobId фиксирован, чтобы повторный запуск не дублировал расписание
        jobId: `cron:${job.name}`,
      },
    );
  }
  getLogger().info(`[scheduler] registered ${jobs.length} cron jobs`);
}

// ───── Worker ─────

export function startCronTasksWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case 'reset-traffic-daily': {
          const n = await resetTrafficForStrategy('day');
          if (n > 0) getLogger().info(`[cron] reset-traffic-daily - reset ${n} users`);
          break;
        }
        case 'reset-traffic-weekly': {
          const n = await resetTrafficForStrategy('week');
          if (n > 0) getLogger().info(`[cron] reset-traffic-weekly - reset ${n} users`);
          break;
        }
        case 'reset-traffic-monthly': {
          const n = await resetTrafficForStrategy('month');
          if (n > 0) getLogger().info(`[cron] reset-traffic-monthly - reset ${n} users`);
          break;
        }
        case 'reset-traffic-monthly-rolling': {
          const n = await resetTrafficRolling();
          if (n > 0) getLogger().info(`[cron] reset-traffic-monthly-rolling - reset ${n} users`);
          break;
        }
        case 'review-find-expired': {
          const n = await findExpiredUsers();
          if (n > 0) getLogger().info(`[cron] review-find-expired - flipped ${n} users → expired`);
          break;
        }
        case 'review-find-exceeded-traffic': {
          const n = await findExceededTrafficUsers();
          if (n > 0) getLogger().info(`[cron] review-find-exceeded-traffic - flipped ${n} users → limited`);
          break;
        }
        case 'node-healthcheck-poll': {
          const { ok, down } = await pollNodeStatuses();
          // Only log when something is actually unhealthy, quiet ticks keep
          // the journal readable. ok-counts don't matter unless you graph them.
          if (down > 0) {
            getLogger().info(`[cron] node-healthcheck-poll - ${ok} online, ${down} unreachable`);
          }
          break;
        }
        case 'node-metrics-poll': {
          const { failed } = await pollNodeMetrics();
          if (failed > 0) {
            getLogger().info(`[cron] node-metrics-poll - ${failed} nodes failed to report metrics`);
          }
          break;
        }
        case 'node-stats-poll': {
          const { failed } = await pollNodeStats();
          if (failed > 0) {
            getLogger().info(`[cron] node-stats-poll - ${failed} nodes failed`);
          }
          break;
        }
        case 'reconcile-orphan-users': {
          const n = await reconcileOrphanNodeUsers();
          if (n > 0) getLogger().info(`[cron] reconcile-orphan-users - re-queued removeUser for ${n} users`);
          break;
        }
        case 'alert-near-expiry': {
          const n = await alertNearLimits();
          if (n > 0) getLogger().info(`[cron] alert-near-expiry - digest sent for ${n} user(s)`);
          break;
        }
        case 'geo-rebuild': {
          const r = await refreshGeoAndRepush();
          if (r.changed) {
            getLogger().info(
              `[cron] geo-rebuild - custom geo databases changed, re-pushed ${r.nodes} cascade node(s)`,
            );
          }
          break;
        }
        case 'remnawave-expiry-notify': {
          const n = await scanRemnaExpiryNotifications();
          if (n > 0) getLogger().info(`[cron] remnawave-expiry-notify - emitted ${n} expiry webhook(s)`);
          break;
        }
        case 'prune-history': {
          const r = await pruneHistory();
          const total =
            r.subscriptionRequests + r.nodeUserUsage + r.nodeUsage + r.subscriptionEvents + r.bootstrapTokens;
          if (total > 0) {
            getLogger().info(
              `[cron] prune-history - deleted ${r.subscriptionRequests} sub-req, ${r.nodeUserUsage} user-usage, ${r.nodeUsage} node-usage, ${r.subscriptionEvents} sub-event, ${r.bootstrapTokens} bootstrap-token rows`,
            );
          }
          break;
        }
        default:
          throw new Error(`Unknown cron job: ${job.name}`);
      }
    },
    {
      connection: redis,
      concurrency: 1, // cron-задачи строго последовательно
    },
  );
}
