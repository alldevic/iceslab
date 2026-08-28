import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { prisma, pingDatabase } from './prisma.js';
import { waitForRedis, closeRedis } from './lib/redis.js';
import { closeNodeTransport } from './modules/nodes/nodes.transport.js';
import { registerUserEventHandlers } from './modules/users/users.events.js';
import { registerNodeEventHandlers } from './modules/nodes/nodes.events.js';
import { registerInboundEventHandlers } from './modules/inbounds/inbounds.events.js';
import { registerWebhookEventHandlers } from './modules/webhooks/webhook.events.js';
import { registerPoolEventHandlers } from './modules/ext_vptech_pool/pool.service.js';
import { registerRemnawaveWebhookEmitter } from './modules/remnawave-compat/remnawave.webhook.events.js';
import { registerBindingsCacheBust } from './modules/subscription/subscription.bindings-cache.js';
import { observeWorker } from './lib/queue-observability.js';
import { startNodeUsersWorker } from './modules/users/users.queue.js';
import { startInboundSyncWorker } from './modules/inbounds/inbounds.queue.js';
import {
  startCronTasksWorker,
  registerCronJobs,
} from './modules/scheduler/scheduler.queue.js';
import { buildApp } from './app.js';
import { rebuildGeoAndRepush } from './modules/geo/geo.cron.js';
import { setBaseLogger } from './lib/logger.js';
import { startMetricsRefreshLoop } from './lib/metrics-refresh.js';
import { startTelegramBot } from './lib/telegram-bot.js';

let app: FastifyInstance | null = null;
let nodeUsersWorker: Worker | null = null;
let inboundSyncWorker: Worker | null = null;
let cronTasksWorker: Worker | null = null;
let stopMetricsRefresh: (() => void) | null = null;
let stopTelegramBot: (() => void) | null = null;

async function start() {
  try {
    const dbOk = await pingDatabase();
    if (!dbOk) {
      console.error('Cannot connect to database at startup');
      process.exit(1);
    }

    // Wait, rather than sample. The application client no longer queues
    // commands while it is connecting (lib/redis.ts), so a ping issued in the
    // first moments of boot answers "not ready" instead of waiting for the
    // socket — which would turn a Redis that is one second behind the panel
    // into a panel that refuses to start.
    const redisOk = await waitForRedis();
    if (!redisOk) {
      console.error('Cannot connect to redis at startup');
      process.exit(1);
    }

    registerUserEventHandlers();
    registerNodeEventHandlers();
    registerInboundEventHandlers();
    registerWebhookEventHandlers();
    // F2 - cold-pool hotswap (no-op unless EXT_VPTECH_POOL_ENABLED).
    registerPoolEventHandlers();
    // Remnawave-compat: emit user.expired to the minishop (no-op when the facade
    // or its webhook url/secret are unset).
    registerRemnawaveWebhookEmitter();
    // B6 - invalidate the /sub binding cache on profile/binding/node changes.
    registerBindingsCacheBust();
    // Every worker is wrapped, not just the ones whose handlers happen to log.
    // See lib/queue-observability.ts: cron-tasks announced its successes and
    // said nothing at all when a job threw, which is how a nightly
    // review-find-expired failing forever would have looked.
    nodeUsersWorker = observeWorker(startNodeUsersWorker(), 'node-users');
    inboundSyncWorker = observeWorker(startInboundSyncWorker(), 'inbound-sync');
    cronTasksWorker = observeWorker(startCronTasksWorker(), 'cron-tasks');

    app = await buildApp();
    // Route background-job logs (crons, queue workers, event-bus) through the
    // app's pino instance instead of console.log (B15). Workers started just
    // above only log when a job fires (>=15s later), so the logger is in place.
    setBaseLogger(app.log);
    app.log.info('Database connection verified');
    app.log.info('Redis connection verified');
    app.log.info('Event handlers registered');
    app.log.info('Workers started');

    // Remnawave-compat: a half-configured webhook (only ONE of URL/SECRET set)
    // makes every lifecycle webhook silently no-op — including the 24h auto-renew
    // CHARGE trigger the minishop depends on — with no other signal. Surface it
    // loudly at boot so the operator doesn't believe auto-renew is working.
    if (config.REMNAWAVE_COMPAT_ENABLED) {
      const hasUrl = !!config.REMNAWAVE_COMPAT_WEBHOOK_URL;
      const hasSecret = !!config.REMNAWAVE_COMPAT_WEBHOOK_SECRET;
      if (hasUrl !== hasSecret) {
        app.log.warn(
          `remnawave-compat: webhook is half-configured (${hasUrl ? 'URL set, SECRET missing' : 'SECRET set, URL missing'}) — ALL lifecycle webhooks incl. the 24h auto-renew charge trigger are DISABLED. Set BOTH REMNAWAVE_COMPAT_WEBHOOK_URL and REMNAWAVE_COMPAT_WEBHOOK_SECRET, or clear both.`,
        );
      }
    }

    await registerCronJobs();
    app.log.info('Cron jobs registered');

    stopMetricsRefresh = startMetricsRefreshLoop();
    app.log.info('Metrics refresh loop started');

    // K3 - operator Telegram bot (no-op when Telegram isn't configured).
    stopTelegramBot = startTelegramBot();

    // G6 - warm the in-process geo build cache after a restart (it is not
    // persisted). Fire-and-forget: until it lands, subscriptions/fragments
    // just fall back to external geo URLs / bundled databases; once built,
    // the next poll picks the self-hosted ones up. forceRepush: any egress
    // cascade rendered during the cold-cache window had its ext: matchers
    // stripped, so re-emit cascade.changed once the build lands to refresh them.
    if (config.GEO_SELF_HOST) {
      const log = app.log;
      rebuildGeoAndRepush({ forceRepush: true }).then(
        (meta) => log.info({ artifacts: meta.artifacts.length }, 'geo build cache warmed'),
        (err) => log.warn({ err }, 'geo build warm-up failed'),
      );
    }

    await app.listen({ port: config.APP_PORT, host: config.APP_HOST });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function shutdown() {
  if (app) {
    app.log.info('Shutting down...');
    await app.close();
  }
  if (nodeUsersWorker) {
    await nodeUsersWorker.close();
  }
  if (inboundSyncWorker) {
    await inboundSyncWorker.close();
  }
  if (cronTasksWorker) {
    await cronTasksWorker.close();
  }
  if (stopMetricsRefresh) {
    stopMetricsRefresh();
  }
  if (stopTelegramBot) {
    stopTelegramBot();
  }
  await closeNodeTransport();
  await prisma.$disconnect();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
