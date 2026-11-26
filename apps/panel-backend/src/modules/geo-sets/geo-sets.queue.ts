import { Queue, Worker, type Job } from 'bullmq';
import { GEO_BUILTIN, GEO_BUILTIN_NAMES, GEO_SET_KINDS, type GeoSetKind } from '@iceslab/shared';
import { queueRedis } from '../../lib/infra/redis.js';
import { getLogger } from '../../lib/infra/logger.js';
import { prisma } from '../../prisma.js';
import {
  buildCompositeSet,
  builtinNeedsFetch,
  compositesUsing,
  ensureBuiltinSets,
  fetchBuiltin,
  fetchUrl,
  urlSetDue,
  type IngestOutcome,
} from './geo-sets.store.js';

/**
 * Geo files are fetched and checked in the background: a list of tens of
 * megabytes does not hold an HTTP request open, and the set says `checking`
 * meanwhile (geo-contract.md section 5).
 */

export type GeoSetsJobData = { kind: GeoSetKind } | { setId: string };

const QUEUE_NAME = 'geo-sets';

export const geoSetsQueue = new Queue<GeoSetsJobData>(QUEUE_NAME, {
  connection: queueRedis,
  defaultJobOptions: {
    // One attempt: a failure is written on the set as `broken` in words, and
    // a retry would flip it back to `checking` behind the operator's back.
    // The next start, or "refresh now", tries again.
    attempts: 1,
    // Gone as soon as done: BullMQ ignores an add() whose job id still
    // exists, and a kept job would stop the next start from retrying a
    // broken fetch. The id only has to dedupe jobs waiting or running.
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export async function enqueueBuiltinFetch(kind: GeoSetKind): Promise<void> {
  await geoSetsQueue.add('fetchBuiltin', { kind }, { jobId: `builtin-${kind}-${GEO_BUILTIN[kind].tag}` });
}

/** One fetch per set at a time: a second press of "refresh now" while the
 *  first is still downloading joins it instead of starting another. */
export async function enqueueUrlFetch(setId: string): Promise<void> {
  await geoSetsQueue.add('fetchUrl', { setId }, { jobId: `url-${setId}` });
}

/** One build per composite set at a time; a build that is already waiting
 *  reads the sources when it runs, so a second request joins it. */
export async function enqueueCompositeBuild(setId: string): Promise<void> {
  await geoSetsQueue.add('buildComposite', { setId }, { jobId: `composite-${setId}` });
}

/**
 * A set got a new verified file: the composite sets built from it are built
 * again. Their nodes stay where they are until an operator rolls out.
 */
export async function enqueueDependentBuilds(setName: string): Promise<number> {
  const deps = await compositesUsing(setName);
  for (const d of deps) await enqueueCompositeBuild(d.id);
  return deps.length;
}

/** After a fetch: a new verified file means the composites built from it are built again. */
export async function afterSourceIngest(setName: string, out: IngestOutcome | { status: 'unchanged' }): Promise<void> {
  if (out.status === 'verified') await enqueueDependentBuilds(setName);
}

/**
 * Phase 9.4, on the scheduler's tick: every URL set that is due by its
 * `refreshHours` (urlSetDue) gets a fetch. The fetch is conditional, so a list
 * that did not change costs a 304 and nothing else. Answers how many were
 * queued.
 */
export async function queueDueUrlFetches(now = new Date()): Promise<number> {
  const sets = await prisma.geoSet.findMany({
    where: { sourceType: 'url' },
    select: { id: true, status: true, checkedAt: true, refreshHours: true },
  });
  const due = sets.filter((s) => urlSetDue(s, now));
  for (const s of due) await enqueueUrlFetch(s.id);
  return due.length;
}

/**
 * On start: both built-in sets exist, and the ones not yet on the pinned
 * release get a fetch. The job id names the release, so two starts in a row
 * do not queue the same download twice.
 */
export async function scheduleBuiltinFetch(): Promise<void> {
  await ensureBuiltinSets();
  for (const kind of GEO_SET_KINDS) {
    if (await builtinNeedsFetch(kind)) await enqueueBuiltinFetch(kind);
  }
}

export function startGeoSetsWorker(): Worker<GeoSetsJobData> {
  return new Worker<GeoSetsJobData>(
    QUEUE_NAME,
    async (job: Job<GeoSetsJobData>) => {
      switch (job.name) {
        case 'fetchBuiltin': {
          const kind = (job.data as { kind: GeoSetKind }).kind;
          await afterSourceIngest(GEO_BUILTIN_NAMES[kind], await fetchBuiltin(kind));
          break;
        }
        case 'fetchUrl': {
          const setId = (job.data as { setId: string }).setId;
          const out = await fetchUrl(setId);
          const set = await prisma.geoSet.findUnique({ where: { id: setId }, select: { name: true } });
          if (set) await afterSourceIngest(set.name, out);
          break;
        }
        case 'buildComposite':
          await buildCompositeSet((job.data as { setId: string }).setId);
          break;
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    // One at a time: each job holds a whole file in memory.
    { connection: queueRedis, concurrency: 1 },
  ).on('failed', (job, err) => {
    getLogger().error(`[worker:geo-sets] ${job?.name} ${JSON.stringify(job?.data)} FAILED: ${err.message}`);
  });
}
