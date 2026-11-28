import { readFileSync } from 'node:fs';
import type { Client } from '../pgutil.js';
import { one, rows } from '../pgutil.js';
import type { Report } from '../report.js';
import { step, warn, note } from '../report.js';
import { dataFile } from '../catalogue.js';

/** Small transforms of 20.3, one function each, each idempotent. */

/**
 * BEFORE migrate deploy. The base migration that gives a binding its transport
 * (20260921094444) was written before plain WireGuard profiles existed and
 * stops with "cannot decide a transport" on a binding of one. The old fork has
 * them, so for the length of the deploy those profiles are labelled amneziawg
 * (the same transport, udp), and relabelRestore puts the name back.
 */
export async function relabelWireguardForDeploy(c: Client, report: Report): Promise<number> {
  await c.query(`CREATE TABLE IF NOT EXISTS fork_migration_wg_profiles (id uuid PRIMARY KEY)`);
  await c.query(`INSERT INTO fork_migration_wg_profiles SELECT id FROM profiles WHERE protocol = 'wireguard' ON CONFLICT DO NOTHING`);
  const r = await c.query(`UPDATE profiles SET protocol = 'amneziawg' WHERE id IN (SELECT id FROM fork_migration_wg_profiles) AND protocol = 'wireguard'`);
  step(report, { step: 'wireguard-label-before', status: r.rowCount ? 'done' : 'skipped', summary: `${r.rowCount ?? 0} wireguard profiles labelled amneziawg for the deploy` });
  return r.rowCount ?? 0;
}

export async function relabelWireguardRestore(c: Client, report: Report): Promise<void> {
  const r = await c.query(`UPDATE profiles SET protocol = 'wireguard' WHERE id IN (SELECT id FROM fork_migration_wg_profiles)`);
  await c.query(`DROP TABLE IF EXISTS fork_migration_wg_profiles`);
  step(report, { step: 'wireguard-label-after', status: 'done', summary: `${r.rowCount ?? 0} profiles back to wireguard` });
}

/** engine 'mtproto' (an explicit mtg) is NULL, the native core, in omega: the same behaviour. */
export async function profileEngineStep(c: Client, report: Report): Promise<void> {
  const r = await c.query(`UPDATE profiles SET engine = NULL WHERE engine = 'mtproto'`);
  step(report, { step: 'profile-engine', status: 'done', summary: `${r.rowCount ?? 0} profiles with engine mtproto set to the native core` });
}

/** hwid_user_devices.user_agent TEXT -> VARCHAR(512), cutting what is longer. */
export async function hwidTrimStep(c: Client, report: Report): Promise<void> {
  const cut = await c.query(`UPDATE hwid_user_devices SET user_agent = left(user_agent, 512) WHERE length(user_agent) > 512`);
  await c.query(`ALTER TABLE hwid_user_devices ALTER COLUMN user_agent TYPE VARCHAR(512)`);
  step(report, { step: 'hwid-trim', status: 'done', summary: `${cut.rowCount ?? 0} user agents cut to 512 characters` });
  if (cut.rowCount) warn(report, 'hwid-trimmed', `${cut.rowCount} device user agents were longer than 512 characters and were cut`);
}

/** wg_devices.public_key is unique in omega. The pre-check refuses repeats; here is the index. */
export async function wgUniqueStep(c: Client, report: Report): Promise<void> {
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS wg_devices_public_key_key ON wg_devices (public_key)`);
  step(report, { step: 'wg-unique', status: 'done', summary: 'unique index wg_devices_public_key_key in place' });
}

/** The columns only the old fork had; their values go to the report first. */
export async function dropOldColumnsStep(c: Client, report: Report): Promise<void> {
  const tune = await rows<{ name: string; egress_tune: unknown }>(c, `SELECT name, egress_tune FROM nodes WHERE egress_tune IS NOT NULL`);
  const hop = await rows<{ name: string; port_hopping_start: number; port_hopping_end: number }>(
    c,
    `SELECT name, port_hopping_start, port_hopping_end FROM nodes WHERE port_hopping_start IS NOT NULL OR port_hopping_end IS NOT NULL`,
  );
  const left = await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM cascade_position_nodes WHERE egress_policy IS NOT NULL AND jsonb_typeof(egress_policy) = 'array' AND jsonb_array_length(egress_policy) > 0`);
  await c.query(`ALTER TABLE cascade_position_nodes DROP COLUMN IF EXISTS egress_policy`);
  await c.query(`ALTER TABLE nodes DROP COLUMN IF EXISTS egress_tune, DROP COLUMN IF EXISTS port_hopping_start, DROP COLUMN IF EXISTS port_hopping_end`);
  report.data['droppedColumnValues'] = { egressTune: tune, portHopping: hop, positionPoliciesAtDrop: Number(left?.n ?? 0) };
  step(report, {
    step: 'drop-old-columns',
    status: 'done',
    summary: `cascade_position_nodes.egress_policy, nodes.egress_tune (${tune.length} values), nodes.port_hopping_start/_end (${hop.length} values) dropped`,
  });
  if (hop.length) note(report, 'port-hopping', 'the port hopping range of Hysteria nodes comes back from the new agent; until a node is reinstalled the subscription does not carry it', hop);
}

interface SeedRule {
  name: string;
  uaPattern: string;
  format: string;
  proto: string | null;
  priority: number;
  enabled: boolean;
}
const seed = (file: string): SeedRule[] => JSON.parse(readFileSync(dataFile(file), 'utf8')) as SeedRule[];

/** question 6: rules stay as they are; the difference from a fresh omega install is only printed. */
export async function srrReportStep(c: Client, report: Report): Promise<void> {
  const db = await rows<SeedRule & { ua_pattern?: string }>(
    c,
    `SELECT name, ua_pattern AS "uaPattern", format, proto, priority, enabled FROM subscription_response_rules ORDER BY priority, name`,
  );
  const oldSeed = new Map(seed('srr-seed-old.json').map((r) => [r.name, r]));
  const freshSeed = new Map(seed('srr-seed-omega.json').map((r) => [r.name, r]));
  const fields = ['uaPattern', 'format', 'proto', 'priority', 'enabled'] as const;
  const diff = (a: SeedRule, b: SeedRule) => Object.fromEntries(fields.filter((f) => a[f] !== b[f]).map((f) => [f, { now: a[f], freshInstall: b[f] }]));
  const differsFromFresh: unknown[] = [];
  const editedByOperator: string[] = [];
  const extra: string[] = [];
  for (const r of db) {
    const fresh = freshSeed.get(r.name);
    const old = oldSeed.get(r.name);
    if (!fresh) {
      extra.push(r.name);
      continue;
    }
    const d = diff(r, fresh);
    if (Object.keys(d).length === 0) continue;
    if (old && Object.keys(diff(r, old)).length === 0) differsFromFresh.push({ name: r.name, origin: 'old fork seed, untouched', differs: d });
    else {
      editedByOperator.push(r.name);
      differsFromFresh.push({ name: r.name, origin: 'edited by the operator or by a migration of the old fork', differs: d });
    }
  }
  const dbNames = new Set(db.map((r) => r.name));
  const missing = [...freshSeed.keys()].filter((n) => !dbNames.has(n));
  report.data['srr'] = { differsFromFresh, editedByOperator, notInFreshSeed: extra, missingFromDatabase: missing };
  step(report, {
    step: 'srr-report',
    status: 'done',
    summary: `${differsFromFresh.length} response rules differ from a fresh omega install, ${extra.length} are the operator's own, ${missing.length} seeded ones are absent; nothing changed`,
  });
  if (differsFromFresh.length) warn(report, 'srr-differs', `${differsFromFresh.length} subscription response rules differ from a fresh install (left as they are)`, differsFromFresh);
}
