import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { BlockedError, runMigration } from './migrate.js';
import { runPrecheck } from './precheck.js';
import { swapBack, swapIn } from './swap.js';
import { connect } from './pgutil.js';
import { checksums, numericIdSequence, rowCounts } from './snapshot.js';
import type { Report } from './report.js';

/**
 * scripts/ops/migrate-from-fork.sh runs this inside the panel image of the new
 * fork:  node dist-fork-migration/scripts/fork-migration/cli.js <command> [flags]
 *
 *   check      read-only pre-check; JSON report to --out (exit 0 when nothing blocks, 3 when something does)
 *   migrate    pre-check, copy, journal, prisma migrate deploy, transforms, verification (on the copy)
 *   swap       rename the migrated copy to the live name (the old database kept as <live>_pre_fork)
 *   unswap     the way back
 *   snapshot   row counts and checksums of a database (for before/after comparison on the stand)
 *
 * The database comes from DATABASE_URL; JWT_SECRET, TRUST_PROXY_HOPS and
 * SUBSCRIPTION_PATH_PREFIX are read from the environment the shell passes in.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function writeJson(path: string | undefined, data: unknown): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function summarize(r: Report): void {
  const line = (k: string, items: { code: string; message: string }[]): void => {
    for (const f of items) console.log(`  ${k} [${f.code}] ${f.message}`);
  };
  line('BLOCKING', r.blocking);
  line('warning ', r.warnings);
  line('info    ', r.info);
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const out = arg('out');
  const common = { databaseUrl, acceptLoss: flag('accept-loss'), env: process.env, ...(process.env['REDIS_URL'] ? { redisUrl: process.env['REDIS_URL'] } : {}) };

  switch (cmd) {
    case 'check': {
      const r = await runPrecheck(common);
      writeJson(out, r);
      summarize(r);
      console.log(r.blocking.length ? `pre-check: ${r.blocking.length} blocking findings` : 'pre-check: nothing blocks the move');
      return r.blocking.length ? 3 : 0;
    }
    case 'migrate': {
      try {
        const target = arg('target');
        const { report, target: db, notConverted } = await runMigration({ ...common, ...(target ? { targetName: target } : {}) });
        writeJson(out, report);
        if (out) writeJson(join(dirname(out), 'egress-policies-not-converted.json'), notConverted);
        summarize(report);
        console.log(`migrated copy ready: ${db}`);
        return 0;
      } catch (err) {
        if (err instanceof BlockedError) {
          writeJson(out, err.report);
          summarize(err.report);
          console.error('pre-check: the move is stopped');
          return 3;
        }
        const rep = (err as { report?: Report }).report;
        if (rep) {
          writeJson(out, rep);
          summarize(rep);
        }
        console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    case 'swap': {
      const r = await swapIn(databaseUrl, arg('target'));
      console.log(`swapped: ${r.live} is the migrated database, the old one is kept as ${r.pre}`);
      return 0;
    }
    case 'unswap': {
      const r = await swapBack(databaseUrl);
      console.log(`rolled back: ${r.live} is the old database again, the migrated one is kept as ${r.kept}`);
      return 0;
    }
    case 'snapshot': {
      const c = await connect(databaseUrl);
      try {
        const snap = { rowCounts: await rowCounts(c), checksums: await checksums(c), numericIdSequence: await numericIdSequence(c) };
        writeJson(out, snap);
        if (!out) console.log(JSON.stringify(snap, null, 2));
      } finally {
        await c.end();
      }
      return 0;
    }
    default:
      console.error('usage: cli.js check|migrate|swap|unswap|snapshot [--out file] [--accept-loss] [--target name]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
