import { oldMigrationNames, omegaMigrationNames, dataFile, OLD_COMMIT } from './catalogue.js';
import { withClient, one, rows } from './pgutil.js';
import type { Client } from './pgutil.js';
import { diffStatements, OLD_SCHEMA, schemaDiff } from './prisma-cli.js';
import { block, newReport, note, warn, type Report } from './report.js';
import { rowCounts } from './snapshot.js';
import { checkStoredContent, LOSSY_KEYS } from './stored-content.js';
import { readFileSync } from 'node:fs';

/**
 * The pre-check of 20.3 (`--check`, and the first step of `--run`): reads the
 * installation of the old fork and says what would stop the move, what would be
 * lost, and what changes. Writes nothing to the database.
 */

export interface PrecheckOptions {
  databaseUrl: string;
  /** The operator accepts the loss of post-quantum / abusePolicy profile fields. */
  acceptLoss: boolean;
  env?: NodeJS.ProcessEnv;
  redisUrl?: string;
}

/** Protocols the base migration 20260921094444 can give a transport; wireguard is handled by the bridge. */
const TRANSPORT_KNOWN = ['hysteria', 'tuic', 'amneziawg', 'xray', 'naive', 'anytls', 'shadowtls', 'shadowsocks', 'mtproto', 'mieru'];
/** The values 20260922061809_link_protocol_is_a_cell accepts. */
const LINK_PROTOCOLS = ['vless', 'shadowsocks', 'hy2', 'tuic', 'xray', 'hysteria', 'amneziawg', 'naive', 'mtproto', 'mieru', 'anytls', 'shadowtls'];

const cap = <T>(a: T[], n = 25): T[] => a.slice(0, n);

async function journal(c: Client, r: Report): Promise<boolean> {
  const hasTable = await one(c, `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`);
  if (!hasTable) {
    block(r, 'not-an-installation', 'The database has no migration journal (_prisma_migrations): this is not an installation of the old fork.');
    return false;
  }
  const j = await rows<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
    c,
    `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`,
  );
  const names = new Set(j.map((x) => x.migration_name));
  const old = new Set(oldMigrationNames());
  const omegaOnly = omegaMigrationNames().filter((n) => !old.has(n) && names.has(n));
  r.data['journal'] = { rows: j.length };
  if (omegaOnly.length > 0) {
    block(r, 'already-migrated', `The journal already holds ${omegaOnly.length} migrations of the new fork (${omegaOnly[0]} ...): this installation has been moved already, there is nothing to carry over.`, cap(omegaOnly, 5));
    return false;
  }
  const missing = [...old].filter((n) => !names.has(n));
  const unknown = [...names].filter((n) => !old.has(n));
  if (missing.length || unknown.length) {
    block(
      r,
      'not-old-fork-commit',
      `The migration journal is not the ${old.size} migrations of the old fork at ${OLD_COMMIT} (${missing.length} missing, ${unknown.length} unknown). Update the old fork to ${OLD_COMMIT} first, with its own deploy, then run this again.`,
      { missing: cap(missing), unknown: cap(unknown) },
    );
    return false;
  }
  const bad = j.filter((x) => x.finished_at === null || x.rolled_back_at !== null);
  if (bad.length) {
    block(r, 'journal-unfinished', `${bad.length} migrations are failed or rolled back in the journal (${bad[0]!.migration_name} ...). Resolve them in the old fork first (prisma migrate resolve), then run this again.`, cap(bad.map((x) => x.migration_name)));
    return false;
  }
  return true;
}

async function schema(databaseUrl: string, r: Report): Promise<void> {
  const d = await schemaDiff(databaseUrl, OLD_SCHEMA());
  const golden = diffStatements(readFileSync(dataFile('old-schema-drift.sql'), 'utf8'));
  const got = d.equal ? [] : d.statements;
  const extra = got.filter((s) => !golden.includes(s));
  const missing = golden.filter((s) => !got.includes(s));
  if (extra.length || missing.length) {
    block(r, 'schema-drift', `The database schema is not the schema of the old fork at ${OLD_COMMIT} (${extra.length} statements it has beyond the known drift, ${missing.length} the known drift expects and it lacks). Someone changed it by hand, or the old fork is not at ${OLD_COMMIT}.`, {
      extra: cap(extra),
      missing: cap(missing),
    });
  }
}

async function predicates(c: Client, r: Report): Promise<void> {
  const badLink = await rows<{ v: string }>(
    c,
    `SELECT DISTINCT v FROM (SELECT link_protocol AS v FROM cascade_positions UNION ALL SELECT link_protocol FROM cascade_hops) s
      WHERE v IS NOT NULL AND v <> ALL ($1::text[])`,
    [LINK_PROTOCOLS],
  );
  if (badLink.length) block(r, 'link-protocol-unknown', `Cascade link_protocol holds values the new fork's migration does not recognise: ${badLink.map((x) => x.v).join(', ')}.`, badLink.map((x) => x.v));

  const noPort = await rows<{ id: string; cascade: string }>(c, `SELECT l.id, c.name AS cascade FROM cascade_links l JOIN cascades c ON c.id = l.cascade_id WHERE l.config->>'port' IS NULL`);
  if (noPort.length) block(r, 'cascade-link-no-port', `${noPort.length} cascade links carry no port in their credentials, which the new schema requires.`, cap(noPort));

  const protos = await rows<{ protocol: string; n: string }>(c, `SELECT p.protocol, count(*)::text AS n FROM profile_node_bindings b JOIN profiles p ON p.id = b.profile_id GROUP BY p.protocol`);
  const unknownProtocol = protos.filter((x) => !TRANSPORT_KNOWN.includes(x.protocol) && x.protocol !== 'wireguard');
  if (unknownProtocol.length) block(r, 'binding-transport-unknown', `Bindings of profiles with protocol(s) ${unknownProtocol.map((x) => x.protocol).join(', ')} get no transport from the new fork's migration.`, unknownProtocol);
  const wg = protos.find((x) => x.protocol === 'wireguard');
  if (wg) note(r, 'wireguard-bindings', `${wg.n} bindings belong to plain WireGuard profiles. The base migration that adds the transport predates that protocol and refuses them; the script labels those profiles amneziawg (the same transport) for the length of the deploy and restores the name.`);

  const dupBinding = await rows(c, `SELECT b.node_id, b.port, count(*)::text AS n FROM profile_node_bindings b GROUP BY 1, 2 HAVING count(*) > 1`);
  if (dupBinding.length) block(r, 'binding-collision', 'Bindings collide on (node, port).', cap(dupBinding));

  const dupKey = await rows<{ public_key: string; n: string }>(c, `SELECT public_key, count(*)::text AS n FROM wg_devices GROUP BY public_key HAVING count(*) > 1`);
  if (dupKey.length) {
    block(r, 'wg-key-repeated', `${dupKey.length} WireGuard public keys are held by more than one device; the new fork keeps the key unique. Revoke or re-issue the repeats in the old fork first.`, cap(dupKey.map((x) => ({ publicKey: x.public_key.slice(0, 12) + '...', devices: Number(x.n) }))));
  }

  const ua = await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM hwid_user_devices WHERE length(user_agent) > 512`);
  if (Number(ua?.n) > 0) warn(r, 'hwid-user-agent-long', `${ua!.n} device user agents are longer than 512 characters and will be cut.`);

  for (const t of ['inbounds', 'group_inbounds']) {
    const n = Number((await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM ${t}`))?.n);
    if (n > 0) block(r, 'dead-table-not-empty', `The table ${t} holds ${n} rows. The old fork stopped using it long ago and the new fork drops it, so the rows would be lost without a word. Check what they are and empty the table.`, { table: t, rows: n });
  }
}

async function lossy(c: Client, r: Report, acceptLoss: boolean): Promise<void> {
  const keys = LOSSY_KEYS as readonly string[];
  const hits: Array<{ where: string; profile: string; keys: string[]; users: number }> = [];
  const profiles = await rows<{ id: string; name: string; config: Record<string, unknown> | null }>(c, `SELECT id, name, config FROM profiles`);
  const users = async (profileId: string): Promise<number> =>
    Number((await one<{ n: string }>(c, `SELECT count(DISTINCT gm.user_id)::text AS n FROM group_profiles gp JOIN group_members gm ON gm.group_id = gp.group_id JOIN users u ON u.id = gm.user_id WHERE gp.profile_id = $1 AND u.deleted_at IS NULL`, [profileId]))?.n);
  for (const p of profiles) {
    const k = Object.keys(p.config ?? {}).filter((x) => keys.includes(x) && (p.config as Record<string, unknown>)[x] != null);
    if (k.length) hits.push({ where: 'profile config', profile: p.name, keys: k, users: await users(p.id) });
  }
  const overrides = await rows<{ id: string; profile_id: string; name: string; overrides: Record<string, unknown> }>(c, `SELECT b.id, b.profile_id, p.name, b.overrides FROM profile_node_bindings b JOIN profiles p ON p.id = b.profile_id WHERE b.overrides IS NOT NULL`);
  for (const b of overrides) {
    const k = Object.keys(b.overrides).filter((x) => keys.includes(x) && b.overrides[x] != null);
    if (k.length) hits.push({ where: 'binding overrides', profile: b.name, keys: k, users: await users(b.profile_id) });
  }
  r.data['lossyProfiles'] = hits;
  if (!hits.length) return;
  const text = `${hits.length} profile settings use post-quantum REALITY / VLESS Encryption fields or abusePolicy, which the new fork dropped by decision. Clients that already hold links built on them will stop connecting until their profiles are re-issued.`;
  if (acceptLoss) warn(r, 'lossy-profiles-accepted', `${text} Continuing because --accept-loss was given.`, hits);
  else block(r, 'lossy-profiles', `${text} Re-issue the profiles first, or run again with --accept-loss to carry on and lose the fields.`, hits);
}

async function classes(c: Client, r: Report): Promise<void> {
  const eng = Number((await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM profiles WHERE engine = 'mtproto'`))?.n);
  if (eng) note(r, 'engine-mtproto', `${eng} profiles name the engine "mtproto"; they become the native core (the same behaviour).`);

  const nodes = await rows<{ name: string; hardening: Record<string, unknown> | null; egress_tune: unknown; port_hopping_start: number | null; port_hopping_end: number | null }>(
    c,
    `SELECT name, hardening, egress_tune, port_hopping_start, port_hopping_end FROM nodes WHERE deleted_at IS NULL`,
  );
  const withKey = (k: string): string[] => nodes.filter((n) => n.hardening && k in n.hardening).map((n) => n.name);
  const z = withKey('zapret2');
  if (z.length) warn(r, 'zapret2-config', `${z.length} nodes carry a zapret2 configuration. The new fork does not have zapret2: the values go to the report and the keys are removed. The zapret2 services and the self-tune timer stay on those nodes until cleaned by hand (the document lists them).`, z);
  const bridge = withKey('bridgeNonXrayInbounds');
  if (bridge.length) warn(r, 'bridge-non-xray', `${bridge.length} nodes have bridgeNonXrayInbounds; the key is removed (the new fork has no such switch).`, bridge);
  const nodeEg = withKey('egressPolicy');
  if (nodeEg.length) note(r, 'egress-policy-node', `${nodeEg.length} nodes have an egress policy; each becomes a node policy "fork-<node>".`, nodeEg);
  const tuned = nodes.filter((n) => n.egress_tune !== null).map((n) => n.name);
  if (tuned.length) note(r, 'egress-tune', `${tuned.length} nodes hold a self-tuned egress strategy; the values go to the report, the column goes.`, tuned);
  const hop = nodes.filter((n) => n.port_hopping_start !== null).map((n) => ({ node: n.name, from: n.port_hopping_start, to: n.port_hopping_end }));
  if (hop.length) note(r, 'port-hopping', 'The Hysteria port-hopping range of these nodes is read from the agent in the new fork; the subscription carries it again after the agent is reinstalled.', hop);

  const pos = await rows<{ n: string }>(c, `SELECT count(*)::text AS n FROM cascade_position_nodes WHERE egress_policy IS NOT NULL AND jsonb_array_length(egress_policy) > 0`);
  if (Number(pos[0]?.n)) note(r, 'egress-policy-position', `${pos[0]!.n} cascade members carry an egress policy; those of a node that sits in one position only (and has no policy of its own) are converted, the rest are written to the report in full.`);

  const geo = await rows<{ key: string; n: number }>(c, `SELECT key, CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) ELSE 0 END AS n FROM app_settings WHERE key IN ('geoSources', 'geoCategories')`);
  for (const g of geo) if (g.n) note(r, `settings-${g.key}`, `${g.n} entries in ${g.key}: converted to geo sets of the new fork (nothing is rolled out to nodes).`);

  const ext = await rows<{ t: string; n: string }>(
    c,
    `SELECT 'profile_node_bindings.overrides' AS t, count(*)::text AS n FROM profile_node_bindings WHERE overrides::text ILIKE '%geo-custom%'
     UNION ALL SELECT 'route_policies', count(*)::text FROM route_policies WHERE direct_domains::text ILIKE '%geo-custom%' OR block_domains::text ILIKE '%geo-custom%'
     UNION ALL SELECT 'app_settings', count(*)::text FROM app_settings WHERE value::text ILIKE '%geo-custom%' AND key NOT IN ('geoCategories', 'geoSources')`,
  );
  const used = ext.filter((e) => Number(e.n) > 0);
  if (used.length) note(r, 'geo-custom-refs', 'Stored rules name ext:geo-custom.dat categories; they are rewritten to the composite sets.', used);
}

async function content(c: Client, r: Report): Promise<void> {
  const res = await checkStoredContent(c);
  r.data['storedContent'] = { checked: res.checked, unreadable: res.problems.length };
  if (res.problems.length) warn(r, 'stored-content-unreadable', `${res.problems.length} stored rows are not read by the new panel's schemas (listed one by one).`, res.problems.map((p) => p.message));
  if (res.strippedKeys.length) {
    warn(r, 'config-keys-dropped', `${res.strippedKeys.length} profile configs hold keys the new panel's schema drops when it reads them (a Hysteria pin, the post-quantum and abuse fields).`, res.strippedKeys);
  }
}

async function environment(c: Client, r: Report, opts: PrecheckOptions): Promise<void> {
  const env = opts.env ?? process.env;
  if (!env['JWT_SECRET']) {
    block(r, 'jwt-secret-missing', 'JWT_SECRET is not set for the script. It must be the very value the old panel runs with: the entry nodes subscribers were given and the geo links derive from it, and a different one breaks them.');
  }
  const v = await one<{ v: string }>(c, `SHOW server_version`);
  const size = await one<{ s: string }>(c, `SELECT pg_database_size(current_database())::text AS s`);
  r.data['environment'] = { postgres: v?.v, databaseBytes: Number(size?.s), trustProxyHops: env['TRUST_PROXY_HOPS'] ?? null, subscriptionPathPrefix: env['SUBSCRIPTION_PATH_PREFIX'] ?? null };
  if (env['TRUST_PROXY_HOPS'] === undefined) {
    warn(r, 'trust-proxy-hops-unset', 'TRUST_PROXY_HOPS is not set in the old panel; the new default differs (2 against 1). The script writes the old effective value into the environment file so the number of proxy hops does not change.');
  }
  if (opts.redisUrl) {
    try {
      const { Redis } = await import('ioredis');
      const redis = new Redis(opts.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
      await redis.connect();
      const noTtl: string[] = [];
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
        cursor = next;
        for (const k of keys) if ((await redis.pttl(k)) === -1) noTtl.push(k);
      } while (cursor !== '0');
      await redis.quit();
      r.data['redisKeysWithoutTtl'] = cap(noTtl, 50);
      note(r, 'redis-no-ttl', `${noTtl.length} Redis keys have no expiry (queues and counters); Redis is flushed during the move, nothing in it is the operator's data.`, cap(noTtl, 20));
    } catch (err) {
      warn(r, 'redis-unreadable', `Redis could not be listed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function runPrecheck(opts: PrecheckOptions): Promise<Report> {
  const r = newReport('check');
  await withClient(opts.databaseUrl, async (c) => {
    const ok = await journal(c, r);
    if (ok) {
      r.data['rowCounts'] = await rowCounts(c);
      await environment(c, r, opts);
      await schema(opts.databaseUrl, r);
      await predicates(c, r);
      await lossy(c, r, opts.acceptLoss);
      await classes(c, r);
      await content(c, r);
    } else {
      await environment(c, r, opts);
    }
  });
  r.finishedAt = new Date().toISOString();
  return r;
}
