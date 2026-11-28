import type { Client } from './pgutil.js';
import { ANALOGS, OLD_ONLY_MIGRATIONS, migrationsToApply, omegaMigrationNames } from './catalogue.js';
import { connect, databaseName, ident, one, rows, withClient, withDatabase } from './pgutil.js';
import { OMEGA_SCHEMA, runPrisma, schemaDiff } from './prisma-cli.js';
import { runPrecheck, type PrecheckOptions } from './precheck.js';
import { block, newReport, step, warn, type Report } from './report.js';
import { checksums, numericIdSequence, rowCounts } from './snapshot.js';
import { checkNodePolicies, checkStoredContent } from './stored-content.js';
import { convertEgressPolicies, type NotConverted } from './transforms/egress.js';
import { geoStep } from './transforms/geo.js';
import { stripHardeningStep } from './transforms/hardening.js';
import { lossStep } from './transforms/loss.js';
import {
  dropOldColumnsStep,
  hwidTrimStep,
  profileEngineStep,
  relabelWireguardForDeploy,
  relabelWireguardRestore,
  srrReportStep,
  wgUniqueStep,
} from './transforms/misc.js';

/**
 * Steps 2-6 of the order of 20.3 (б'), on a COPY of the database: the live one
 * is only read. The copy is made inside the same Postgres server, so the volume
 * does not change; the swap (swap.ts) is a separate, last act.
 */

export interface MigrateOptions extends PrecheckOptions {
  /** The copy to build; defaults to <live>_migrating. */
  targetName?: string;
  log?: (line: string) => void;
}

export class BlockedError extends Error {
  constructor(public report: Report) {
    super('the pre-check found blocking findings');
  }
}

/** Tables the new fork lacks or may shrink: the allowed reductions of the row count. */
const MAY_SHRINK: Record<string, string> = {
  inbounds: 'dropped by the new fork (the pre-check refuses it non-empty)',
  group_inbounds: 'dropped by the new fork (the pre-check refuses it non-empty)',
  group_cascade_exits: 'the base migration folds exits of one direction into one row per direction',
};

async function inTx(c: Client, report: Report, name: string, fn: () => Promise<void>): Promise<void> {
  await c.query('BEGIN');
  try {
    await fn();
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    step(report, { step: name, status: 'failed', summary: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function createCopy(adminUrl: string, source: string, target: string): Promise<void> {
  if (!target.endsWith('_migrating')) throw new Error(`refusing to drop or build a database not named *_migrating: ${target}`);
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(target)}`);
    try {
      await c.query(`CREATE DATABASE ${ident(target)} TEMPLATE ${ident(source)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot copy "${source}": ${msg}. Stop everything that is connected to it (the backend and frontend containers) and try again.`, { cause: err });
    }
  });
}

export async function runMigration(opts: MigrateOptions): Promise<{ report: Report; target: string; notConverted: NotConverted[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const source = databaseName(opts.databaseUrl);
  const target = opts.targetName ?? `${source}_migrating`;
  const adminUrl = withDatabase(opts.databaseUrl, 'postgres');
  const targetUrl = withDatabase(opts.databaseUrl, target);

  log('[1/6] pre-check');
  const pre = await runPrecheck(opts);
  if (pre.blocking.length) throw new BlockedError(pre);

  const report = newReport('migrate');
  report.source = source;
  report.target = target;
  report.warnings.push(...pre.warnings);
  report.info.push(...pre.info);
  report.data['precheck'] = pre.data;

  const { counts: before, sums: sumsBefore, sequence: seqBefore } = await withClient(opts.databaseUrl, async (c) => ({
    counts: await rowCounts(c),
    sums: await checksums(c, hashedColumns(opts)),
    sequence: await numericIdSequence(c),
  }));

  log(`[2/6] copy ${source} -> ${target}`);
  await createCopy(adminUrl, source, target);
  step(report, { step: 'copy', status: 'done', summary: `${target} created from ${source} (TEMPLATE); ${source} is not touched` });

  const c = await connect(targetUrl);
  let notConverted: NotConverted[] = [];
  try {
    log('[3/6] journal');
    await relabelWireguardForDeploy(c, report);
    await c.end();
    for (const name of Object.keys(ANALOGS)) {
      const r = await runPrisma(['migrate', 'resolve', '--applied', name], targetUrl);
      if (r.code !== 0) throw new Error(`prisma migrate resolve --applied ${name} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
    }
    const j = await connect(targetUrl);
    try {
      await inTx(j, report, 'journal', async () => {
        const del = await j.query(`DELETE FROM _prisma_migrations WHERE migration_name = ANY($1::text[])`, [OLD_ONLY_MIGRATIONS]);
        if (del.rowCount !== OLD_ONLY_MIGRATIONS.length) throw new Error(`expected to remove ${OLD_ONLY_MIGRATIONS.length} old journal rows, removed ${del.rowCount}`);
      });
    } finally {
      await j.end();
    }
    step(report, { step: 'journal', status: 'done', summary: `${Object.keys(ANALOGS).length} analogs marked applied; ${OLD_ONLY_MIGRATIONS.length} old rows removed`, details: { analogs: Object.keys(ANALOGS), removed: OLD_ONLY_MIGRATIONS } });

    log('[4/6] prisma migrate deploy');
    const expected = migrationsToApply();
    const dep = await runPrisma(['migrate', 'deploy'], targetUrl);
    const applied = [...dep.stdout.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]!);
    step(report, {
      step: 'migrate-deploy',
      status: dep.code === 0 ? 'done' : 'failed',
      summary: `${applied.length} migrations applied (expected ${expected.length})`,
      details: { applied: applied.length, output: dep.code === 0 ? undefined : (dep.stderr + dep.stdout).slice(-2000) },
    });
    if (dep.code !== 0) throw new Error(`prisma migrate deploy failed: ${(dep.stderr || dep.stdout).slice(-1500)}`);
    if (applied.length !== expected.length || applied.some((n, i) => n !== expected[i])) {
      throw new Error(`migrate deploy applied ${applied.length} migrations, ${expected.length} were expected`);
    }
    if (/warn/i.test(dep.stderr)) warn(report, 'prisma-warning', 'prisma printed warnings during migrate deploy', dep.stderr.slice(0, 1000));

    log('[5/6] transforms');
    const t = await connect(targetUrl);
    try {
      await inTx(t, report, 'wireguard-label-after', () => relabelWireguardRestore(t, report));
      await inTx(t, report, 'profile-engine', () => profileEngineStep(t, report));
      await inTx(t, report, 'egress-policies', async () => {
        notConverted = await convertEgressPolicies(t, report);
      });
      await inTx(t, report, 'hardening-strip', () => stripHardeningStep(t, report));
      await inTx(t, report, 'geo', () => geoStep(t, report));
      if (opts.acceptLoss) await inTx(t, report, 'accept-loss', () => lossStep(t, report));
      await inTx(t, report, 'hwid-trim', () => hwidTrimStep(t, report));
      await inTx(t, report, 'wg-unique', () => wgUniqueStep(t, report));
      await inTx(t, report, 'drop-old-columns', () => dropOldColumnsStep(t, report));
      await inTx(t, report, 'srr-report', () => srrReportStep(t, report));
      report.data['egressNotConverted'] = notConverted;
      if (notConverted.length) {
        warn(report, 'egress-not-converted', `${notConverted.length} egress policies were not converted and are written in full in egress-policies-not-converted.json`, notConverted.map((n) => ({ scope: n.scope, node: n.node, cascade: n.cascade, reason: n.reason })));
      }
    } finally {
      await t.end();
    }

    log('[6/6] verification');
    await verify(opts, targetUrl, report, before, sumsBefore, seqBefore);
  } catch (err) {
    report.finishedAt = new Date().toISOString();
    block(report, 'migration-failed', err instanceof Error ? err.message : String(err));
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { report });
  }
  report.finishedAt = new Date().toISOString();
  return { report, target, notConverted };
}

async function verify(
  opts: MigrateOptions,
  targetUrl: string,
  report: Report,
  before: Record<string, number>,
  sumsBefore: Awaited<ReturnType<typeof checksums>>,
  seqBefore: string | null,
): Promise<void> {
  const problems: string[] = [];
  const d = await schemaDiff(targetUrl, OMEGA_SCHEMA());
  if (!d.equal) problems.push(`the schema is not the schema of the new fork: ${d.statements.slice(0, 5).join(' ')}`);
  const st = await runPrisma(['migrate', 'status'], targetUrl);
  if (st.code !== 0) problems.push(`prisma migrate status: ${(st.stdout + st.stderr).slice(-300)}`);

  await withClient(targetUrl, async (c) => {
    const names = (await rows<{ migration_name: string }>(c, `SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`)).map((r) => r.migration_name);
    const want = omegaMigrationNames();
    if (names.length !== want.length || names.some((n, i) => n !== want[i])) problems.push(`the journal is not exactly the ${want.length} migrations of the new fork`);
    if (names.some((n) => OLD_ONLY_MIGRATIONS.includes(n))) problems.push('the journal still holds migrations of the old fork');

    const after = await rowCounts(c);
    const table: Array<{ table: string; before: number; after: number; verdict: string }> = [];
    for (const [t, n] of Object.entries(before)) {
      const a = after[t];
      if (a === undefined) {
        table.push({ table: t, before: n, after: 0, verdict: (MAY_SHRINK[t] ?? 'missing') + (n === 0 ? ' (was empty)' : '') });
        if (!MAY_SHRINK[t] || n > 0) problems.push(`table ${t} is gone (${n} rows)`);
        continue;
      }
      const ok = a >= n || (t in MAY_SHRINK && t !== 'inbounds' && t !== 'group_inbounds');
      table.push({ table: t, before: n, after: a, verdict: a >= n ? 'ok' : ok ? `reduced: ${MAY_SHRINK[t]}` : 'LOST ROWS' });
      if (!ok) problems.push(`table ${t}: ${n} rows before, ${a} after`);
    }
    report.data['rowCountTable'] = table;

    const sumsAfter = await checksums(c, hashedColumns(opts));
    const sumTable: Array<{ table: string; before: string; after: string; rows: number; equal: boolean }> = [];
    for (const [t, s] of Object.entries(sumsBefore)) {
      const a = sumsAfter[t];
      if (!a) continue;
      const equal = s.md5 === a.md5;
      sumTable.push({ table: t, before: s.md5, after: a.md5, rows: a.rows, equal });
      if (!equal) problems.push(`checksum of ${t} changed`);
    }
    report.data['checksumTable'] = sumTable;
    const seqAfter = await numericIdSequence(c);
    report.data['numericIdSequence'] = { before: seqBefore, after: seqAfter };
    if (seqBefore !== seqAfter) problems.push(`the numeric_id sequence moved: ${seqBefore} -> ${seqAfter}`);

    const res = await checkStoredContent(c);
    report.data['storedContentAfter'] = { checked: res.checked, unreadable: res.problems.length };
    if (res.problems.length) warn(report, 'stored-content-unreadable-after', `${res.problems.length} stored rows are still not read by the new panel`, res.problems.map((p) => p.message));
    const pol = await checkNodePolicies(c);
    if (pol.length) problems.push(...pol.map((p) => p.message));
    const mt = await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM profiles WHERE engine = 'mtproto'`);
    if (Number(mt?.n)) problems.push("profiles with engine 'mtproto' remain");
    const ext = await one<{ n: string }>(
      c,
      `SELECT (SELECT count(*) FROM node_policy_rules WHERE match_domain::text ILIKE '%geo-custom.dat%' OR match_ip::text ILIKE '%geo-custom%.dat%')::text AS n`,
    );
    if (Number(ext?.n)) problems.push('node policy rules still name geo-custom.dat');
  });

  step(report, { step: 'verify', status: problems.length ? 'failed' : 'done', summary: problems.length ? `${problems.length} problems` : 'schema equals the new fork, journal exact, rows kept, secrets equal', details: problems });
  if (problems.length) throw new Error(`verification failed: ${problems.join(' | ')}`);
}

/** With --accept-loss the profile configs lose fields on purpose, so they are left out of the hash. */
function hashedColumns(opts: MigrateOptions): Record<string, string[]> | undefined {
  return opts.acceptLoss ? { profiles: ['id', 'name', 'protocol', 'enabled'] } : undefined;
}
