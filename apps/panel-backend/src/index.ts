import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { prisma, pingDatabase } from './prisma.js';
import { pingRedis, closeRedis } from './lib/infra/redis.js';
import { closeNodeTransport } from './modules/nodes/nodes.transport.js';
import { registerUserEventHandlers } from './modules/users/users.events.js';
import { registerNodeEventHandlers } from './modules/nodes/nodes.events.js';
import { registerInboundEventHandlers } from './modules/inbounds/inbounds.events.js';
import { registerWebhookEventHandlers } from './modules/webhooks/webhook.events.js';
import { registerRemnawaveWebhookEmitter } from './modules/remnawave-compat/remnawave.webhook.events.js';
import { registerBindingsCacheBust } from './modules/subscription/subscription.bindings-cache.js';
import { startNodeUsersWorker } from './modules/users/users.queue.js';
import { checkNodeDrawings, startInboundSyncWorker } from './modules/inbounds/inbounds.queue.js';
import { scheduleBuiltinFetch, startGeoSetsWorker } from './modules/geo-sets/geo-sets.queue.js';
import {
  startCronTasksWorker,
  registerCronJobs,
} from './modules/scheduler/scheduler.queue.js';
import { buildApp } from './app.js';
import { setBaseLogger } from './lib/infra/logger.js';
import { startMetricsRefreshLoop } from './lib/infra/metrics-refresh.js';
import { startTelegramBot } from './lib/notify/telegram-bot.js';
import { assertLinearRegexEngine } from './modules/srr/linear-regex.js';
import { checkStoredRules } from './modules/srr/srr.service.js';
import { reportStoredCascadeProblems } from './modules/cascades/cascade-exclusive.js';

let app: FastifyInstance | null = null;
let nodeUsersWorker: Worker | null = null;
let inboundSyncWorker: Worker | null = null;
let cronTasksWorker: Worker | null = null;
let geoSetsWorker: Worker | null = null;
let stopMetricsRefresh: (() => void) | null = null;
let stopTelegramBot: (() => void) | null = null;

async function start() {
  try {
    // A-019: the User-Agent rules on the public /sub run on V8's linear
    // engine; without it one rule could hold the event loop, so no start.
    assertLinearRegexEngine();

    const dbOk = await pingDatabase();
    if (!dbOk) {
      console.error('Cannot connect to database at startup');
      process.exit(1);
    }

    const redisOk = await pingRedis();
    if (!redisOk) {
      console.error('Cannot connect to redis at startup');
      process.exit(1);
    }

    registerUserEventHandlers();
    registerNodeEventHandlers();
    registerInboundEventHandlers();
    registerWebhookEventHandlers();
    // Remnawave-compat: no-op unless the facade and its webhook are configured.
    registerRemnawaveWebhookEmitter();
    // B6 - invalidate the /sub binding cache on profile/binding/node changes.
    registerBindingsCacheBust();
    nodeUsersWorker = startNodeUsersWorker();
    inboundSyncWorker = startInboundSyncWorker();
    cronTasksWorker = startCronTasksWorker();
    geoSetsWorker = startGeoSetsWorker();

    app = await buildApp();
    // Route background-job logs (crons, queue workers, event-bus) through the
    // app's pino instance instead of console.log (B15). Workers started just
    // above only log when a job fires (>=15s later), so the logger is in place.
    setBaseLogger(app.log);
    app.log.info('Database connection verified');
    app.log.info('Redis connection verified');
    app.log.info('Event handlers registered');
    app.log.info('Workers started');

    // Remnawave-compat: with only one of URL/SECRET set every Remnawave webhook
    // is off, the 24 h auto-renew charge trigger included, and nothing else
    // says so.
    if (config.REMNAWAVE_COMPAT_ENABLED) {
      const hasUrl = !!config.REMNAWAVE_COMPAT_WEBHOOK_URL;
      const hasSecret = !!config.REMNAWAVE_COMPAT_WEBHOOK_SECRET;
      if (hasUrl !== hasSecret) {
        app.log.warn(
          `remnawave-compat: webhook half-configured (${hasUrl ? 'URL set, SECRET missing' : 'SECRET set, URL missing'}); no Remnawave webhooks are sent, the 24h auto-renew trigger included. Set both REMNAWAVE_COMPAT_WEBHOOK_URL and REMNAWAVE_COMPAT_WEBHOOK_SECRET, or neither.`,
        );
      }
    }

    await registerCronJobs();
    app.log.info('Cron jobs registered');

    // A nodes' drawing that changed with this panel (a deploy is no event)
    // goes out now, not with the next unrelated edit (render-drift.ts). In
    // the background: the workers above take the pushes.
    // Said every start, 0 included: a second start with the same drawing
    // queues none, which is how a deploy is checked on the stand (A-278).
    void checkNodeDrawings()
      .then((n) => app?.log.info({ queued: n }, `drawing check at start: ${n} node push(es) queued`))
      .catch((err) => app?.log.error({ err }, 'drawing check failed'));

    // A-019: a stored rule the linear engine cannot run is no longer served;
    // say which, once, rather than let it stop matching in silence.
    await checkStoredRules().catch((err) => app?.log.error({ err }, 'srr: stored rule check failed'));
    // A-101/A-223: nodes stored in two enabled cascades; A-102: transits that
    // cannot tell their directions apart. Named; nothing switched off.
    await reportStoredCascadeProblems().catch((err) => app?.log.error({ err }, 'cascades: conflict check failed'));

    // Phase 9: the built-in geo sets fetch their pinned release in the
    // background. A failure is the set's `broken`, never the panel's start.
    try {
      await scheduleBuiltinFetch();
    } catch (err) {
      app.log.error({ err }, 'geo: could not schedule the built-in sets');
    }

    stopMetricsRefresh = startMetricsRefreshLoop();
    app.log.info('Metrics refresh loop started');

    // K3 - operator Telegram bot (no-op when Telegram isn't configured).
    stopTelegramBot = startTelegramBot();

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
  if (geoSetsWorker) {
    await geoSetsWorker.close();
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
