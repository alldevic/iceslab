import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ANALOGS, OLD_ONLY_MIGRATIONS, omegaMigrationNames } from './catalogue.js';
import { BlockedError, runMigration } from './migrate.js';
import { runPrecheck } from './precheck.js';
import { connect, withClient, withDatabase } from './pgutil.js';
import { OMEGA_SCHEMA, runPrisma, schemaDiff } from './prisma-cli.js';
import { checksums, rowCounts } from './snapshot.js';
import { checkNodePolicies, checkStoredContent } from './stored-content.js';
import { swapBack, swapIn } from './swap.js';
import { oldForkDbs, type OldForkDbs } from './testdb.js';

/**
 * The bridge of 20.3 on a real Postgres: an old-fork-schema database built from
 * the frozen baseline (the 65 migrations of 040410ac), the synthetic rows of
 * fixtures/old-fork-data.sql, then the real run: pre-check, copy, journal,
 * `prisma migrate deploy`, transforms, verification, swap and the way back.
 * The negative cases of the spec (step 11) work on their own copies.
 */

const ENV = { JWT_SECRET: 'x'.repeat(40), TRUST_PROXY_HOPS: '1' } as NodeJS.ProcessEnv;
const URL = process.env['DATABASE_URL']!;
let dbs: OldForkDbs;

async function q<T = Record<string, unknown>>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return withClient(url, async (c: Client) => (await c.query(sql, params)).rows as T[]);
}
const codes = (r: { blocking: Array<{ code: string }> }): string[] => r.blocking.map((b) => b.code);

beforeAll(async () => {
  dbs = await oldForkDbs(URL);
}, 120_000);
afterAll(async () => {
  await dbs?.cleanup();
}, 60_000);

describe('pre-check', () => {
  it('only reads: the rows and the journal are the same after, and nothing blocks the filled installation', async () => {
    const db = await dbs.copy('filled');
    const snap = async () => ({
      counts: await withClient(db.url, (c) => rowCounts(c)),
      journal: await q(db.url, `SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name`),
      databases: (await q<{ datname: string }>(dbs.adminUrl, `SELECT datname FROM pg_database WHERE datname LIKE '${db.name.split('_c')[0]}%' ORDER BY 1`)).map((r) => r.datname),
      sums: await withClient(db.url, (c) => checksums(c)),
    });
    const before = await snap();
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV });
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['zapret2-config', 'bridge-non-xray', 'hwid-user-agent-long']));
    expect(r.info.map((w) => w.code)).toEqual(expect.arrayContaining(['wireguard-bindings', 'engine-mtproto', 'egress-policy-node', 'geo-custom-refs']));
    expect(await snap()).toEqual(before);
  }, 60_000);

  it('knows the old fork schema: a pristine install shows the known drift only, a hand-made column is refused', async () => {
    const db = await dbs.copy('empty');
    expect(codes(await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV }))).toEqual([]);
    await q(db.url, `ALTER TABLE users ADD COLUMN made_by_hand text`);
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV });
    expect(codes(r)).toEqual(['schema-drift']);
    expect(JSON.stringify(r.blocking[0]!.details)).toContain('made_by_hand');
  }, 60_000);

  it('refuses an installation that is not 040410ac: a journal short of a migration, or with a stranger', async () => {
    const short = await dbs.copy('empty');
    await q(short.url, `DELETE FROM _prisma_migrations WHERE migration_name = '20260907120000_srr_v2rayng_plain'`);
    const a = await runPrecheck({ databaseUrl: short.url, acceptLoss: false, env: ENV });
    expect(codes(a)).toEqual(['not-old-fork-commit']);
    expect(a.blocking[0]!.message).toMatch(/Update the old fork to 040410ac first/);
    expect(a.blocking[0]!.details).toMatchObject({ missing: ['20260907120000_srr_v2rayng_plain'] });

    const stranger = await dbs.copy('empty');
    await q(stranger.url, `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('x', 'x', '20270101000000_not_ours', now(), now(), 1)`);
    expect(codes(await runPrecheck({ databaseUrl: stranger.url, acceptLoss: false, env: ENV }))).toEqual(['not-old-fork-commit']);

    const failed = await dbs.copy('empty');
    await q(failed.url, `UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = '20260907120000_srr_v2rayng_plain'`);
    expect(codes(await runPrecheck({ databaseUrl: failed.url, acceptLoss: false, env: ENV }))).toEqual(['journal-unfinished']);
  }, 60_000);

  it('refuses an installation that has been moved already', async () => {
    const db = await dbs.copy('empty');
    await q(db.url, `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('y', 'y', '20261127140000_node_tunnel_ipv6_prefix', now(), now(), 1)`);
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV });
    expect(codes(r)).toEqual(['already-migrated']);
  }, 60_000);

  it('blocks on a link_protocol the base migration would stop on', async () => {
    const db = await dbs.copy('filled');
    await q(db.url, `UPDATE cascade_positions SET link_protocol = 'carrier-pigeon' WHERE "position" = 1 AND link_protocol = 'xray'`);
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV });
    expect(codes(r)).toEqual(['link-protocol-unknown']);
    // and --run refuses to start, on a copy nobody made
    await expect(runMigration({ databaseUrl: db.url, acceptLoss: true, env: ENV, log: () => {} })).rejects.toBeInstanceOf(BlockedError);
    expect(await q(dbs.adminUrl, `SELECT 1 FROM pg_database WHERE datname = $1`, [`${db.name}_migrating`])).toEqual([]);
  }, 60_000);

  it('blocks on a repeated WireGuard key, a cascade link without a port, a non-empty inbounds table', async () => {
    const db = await dbs.copy('filled');
    await q(db.url, `UPDATE wg_devices SET public_key = (SELECT public_key FROM wg_devices WHERE label = 'phone1') WHERE label = 'phone2'`);
    await q(db.url, `UPDATE cascade_links SET config = '{"uuid":"x"}'::jsonb WHERE direction_tag = 2`);
    await q(db.url, `INSERT INTO inbounds (id, node_id, protocol, name, port, config, updated_at) VALUES (gen_random_uuid(), 'c0000000-0000-4000-8000-000000000001', 'xray', 'dead', 9999, '{}', now())`);
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: true, env: ENV });
    expect(codes(r).sort()).toEqual(['cascade-link-no-port', 'dead-table-not-empty', 'wg-key-repeated']);
    const wg = r.blocking.find((b) => b.code === 'wg-key-repeated')!;
    expect(JSON.stringify(wg.details)).not.toContain(await wgKey(db.url)); // the key itself is not printed
  }, 60_000);

  it('blocks on a profile with post-quantum or abusePolicy fields, naming the profile and its users; --accept-loss lets it by', async () => {
    const db = await dbs.copy('filled');
    await q(db.url, `UPDATE profiles SET config = config || '{"realityMldsa65Seed":"seed","realityMldsa65Verify":"verify","abusePolicy":{"blockTorrent":true}}'::jsonb WHERE name = 'reality'`);
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: ENV });
    expect(codes(r)).toEqual(['lossy-profiles']);
    const hit = (r.blocking[0]!.details as Array<{ profile: string; keys: string[]; users: number }>)[0]!;
    expect({ ...hit, keys: [...hit.keys].sort() }).toMatchObject({ profile: 'reality', keys: ['abusePolicy', 'realityMldsa65Seed', 'realityMldsa65Verify'], users: 12 });
    const ok = await runPrecheck({ databaseUrl: db.url, acceptLoss: true, env: ENV });
    expect(ok.blocking).toEqual([]);
    expect(ok.warnings.map((w) => w.code)).toContain('lossy-profiles-accepted');
  }, 60_000);

  it('asks for JWT_SECRET: without it the subscription entries would change', async () => {
    const db = await dbs.copy('empty');
    const r = await runPrecheck({ databaseUrl: db.url, acceptLoss: false, env: {} as NodeJS.ProcessEnv });
    expect(codes(r)).toEqual(['jwt-secret-missing']);
  }, 60_000);
});

async function wgKey(url: string): Promise<string> {
  return (await q<{ public_key: string }>(url, `SELECT public_key FROM wg_devices WHERE label = 'phone1'`))[0]!.public_key;
}

describe('the move of the filled installation', () => {
  const state: { source?: string; target?: string; url?: string; report?: Awaited<ReturnType<typeof runMigration>> } = {};
  let sums: Awaited<ReturnType<typeof checksums>>;
  let counts: Record<string, number>;
  let numericIds: unknown[];
  let tokens: unknown[];

  beforeAll(async () => {
    const db = await dbs.copy('filled');
    state.source = db.name;
    state.url = db.url;
    sums = await withClient(db.url, (c) => checksums(c));
    counts = await withClient(db.url, (c) => rowCounts(c));
    numericIds = await q(db.url, `SELECT username, numeric_id, subscription_token, short_id, xray_uuid FROM users ORDER BY username`);
    tokens = await q(db.url, `SELECT token_hash, scopes FROM api_tokens ORDER BY name`);
    state.report = await runMigration({ databaseUrl: db.url, acceptLoss: false, env: ENV, log: () => {} });
    state.target = state.report.target;
  }, 180_000);

  const target = (): string => withDatabase(URL, state.target!);

  it('applies 48 + 6 migrations, marks the 7 analogs, takes the 15 old names out of the journal', async () => {
    const steps = Object.fromEntries(state.report!.report.steps.map((s) => [s.step, s]));
    expect(steps['migrate-deploy']!.summary).toBe('54 migrations applied (expected 54)');
    expect(steps['journal']!.details).toMatchObject({ analogs: Object.keys(ANALOGS), removed: OLD_ONLY_MIGRATIONS });
    const names = (await q<{ migration_name: string }>(target(), `SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`)).map((r) => r.migration_name);
    expect(names).toEqual(omegaMigrationNames());
    for (const n of OLD_ONLY_MIGRATIONS) expect(names).not.toContain(n);
  });

  it('leaves the database equal to the schema of the new fork and prisma migrate status clean', async () => {
    expect((await schemaDiff(target(), OMEGA_SCHEMA())).equal).toBe(true);
    const st = await runPrisma(['migrate', 'status'], target());
    expect(st.code).toBe(0);
    expect(st.stdout + st.stderr).toMatch(/Database schema is up to date/);
    expect(st.stdout + st.stderr).not.toMatch(/not found locally|failed|drift/i);
  });

  it('did not touch the live database', async () => {
    const c = await connect(state.url!);
    try {
      expect(await rowCounts(c)).toEqual(counts);
      expect(await checksums(c)).toEqual(sums);
    } finally {
      await c.end();
    }
    expect((await q<{ n: string }>(state.url!, `SELECT count(*)::text AS n FROM _prisma_migrations`))[0]!.n).toBe('65');
  });

  it('keeps the secrets, the identities and the numbering: checksums equal, numeric_id and subscription tokens the same', async () => {
    const after = await withClient(target(), (c) => checksums(c));
    for (const [table, s] of Object.entries(sums)) expect(after[table]!.md5, table).toBe(s.md5);
    expect(await q(target(), `SELECT username, numeric_id, subscription_token, short_id, xray_uuid FROM users ORDER BY username`)).toEqual(numericIds);
    expect(await q(target(), `SELECT token_hash, scopes FROM api_tokens ORDER BY name`)).toEqual(tokens);
    // the next user gets the next number
    const next = await q<{ numeric_id: string }>(target(), `SELECT nextval(pg_get_serial_sequence('users', 'numeric_id'))::text AS numeric_id`);
    expect(Number(next[0]!.numeric_id)).toBe(25);
  });

  it('loses no row of a common table; the reductions are the listed ones only', async () => {
    const after = await withClient(target(), (c) => rowCounts(c));
    for (const [t, n] of Object.entries(counts)) {
      if (t === 'inbounds' || t === 'group_inbounds') continue;
      expect(after[t] ?? 0, t).toBeGreaterThanOrEqual(n);
    }
    expect(after['wg_devices']).toBe(counts['wg_devices']);
  });

  it('turns the egress policies of the node and of the lone cascade member into node policies, leaves the rest in the report', async () => {
    const pol = await q<{ node: string; policy: string; rules: string }>(
      target(),
      `SELECT n.name AS node, p.name AS policy, (SELECT count(*)::text FROM node_policy_rules r WHERE r.policy_id = p.id) AS rules FROM nodes n JOIN node_policies p ON p.id = n.policy_id ORDER BY n.name`,
    );
    expect(pol).toEqual([
      { node: 'entry-ru', policy: 'fork-entry-ru', rules: '6' },
      { node: 'mid-fi', policy: 'fork-mid-fi-main-chain', rules: '3' },
    ]);
    const dirRules = await q(target(), `SELECT r.action_kind, d.tag FROM node_policy_rules r JOIN cascade_directions d ON d.id = r.action_direction_id ORDER BY d.tag`);
    expect(dirRules).toEqual([{ action_kind: 'cascade', tag: 1 }, { action_kind: 'cascade', tag: 2 }]);
    expect(state.report!.notConverted.map((n) => `${n.scope}/${n.node}/${n.cascade ?? ''}`).sort()).toEqual([
      'position/entry-ru/main-chain',
      'position/exit-de/main-chain',
      'position/exit-de/second',
    ]);
    expect(await withClient(target(), (c) => checkNodePolicies(c))).toEqual([]);
  });

  it('takes the old keys out of hardening so the strict schema takes it, and keeps pool and the rest', async () => {
    const h = await q<{ name: string; hardening: Record<string, unknown> | null }>(target(), `SELECT name, hardening FROM nodes WHERE name IN ('entry-ru', 'exit-nl') ORDER BY name`);
    expect(h[0]!.hardening).toEqual({ ufwLockdown: true, fail2ban: true, sshAllowlist: ['10.0.0.1', '192.0.2.0/24'], pool: { asn: 'AS64500', provider: 'acme', burned: false } });
    expect(h[1]!.hardening).toEqual({ fail2ban: true });
    expect(state.report!.report.data['hardeningRemoved']).toEqual(expect.arrayContaining([expect.objectContaining({ node: 'entry-ru' })]));
    const cols = (await q<{ column_name: string }>(target(), `SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes' AND column_name IN ('egress_tune', 'port_hopping_start', 'port_hopping_end', 'consumption_multiplier')`)).map((r) => r.column_name);
    expect(cols).toEqual([]);
    expect((await q<{ n: string }>(target(), `SELECT count(*)::text n FROM information_schema.columns WHERE table_name = 'cascade_position_nodes' AND column_name = 'egress_policy'`))[0]!.n).toBe('0');
  });

  it('carries the geo settings into sets, rewrites ext:geo-custom.dat, and rolls nothing out', async () => {
    const sets = await q<{ name: string; kind: string; source_type: string; status: string; url: string | null }>(target(), `SELECT name, kind, source_type, status, url FROM geo_sets ORDER BY name`);
    expect(sets.map((s) => `${s.name}:${s.kind}:${s.source_type}`)).toEqual(['geo-custom:geosite:composite', 'geo-custom-ip:geoip:composite', 'my-geo-source-ip:geoip:url', 'my-geo-source-site:geosite:url']);
    expect(sets.every((s) => s.status === 'checking')).toBe(true);
    expect((await q(target(), `SELECT 1 FROM node_geo_pins`)).length).toBe(0);
    const rp = await q<{ direct_domains: string[]; block_domains: string[] }>(target(), `SELECT direct_domains, block_domains FROM route_policies WHERE name = 'my-lists'`);
    expect(rp[0]!.direct_domains).toEqual(['ext:geo-custom:mycat', 'example.com']);
    expect(rp[0]!.block_domains).toEqual(['ext:geo-custom.dat:Ghost', 'ads.example.com']); // its category could not be carried: named in the report
    const rule = await q<{ value: unknown }>(target(), `SELECT value FROM app_settings WHERE key = 'subscriptionCustomRoutingRules'`);
    expect(JSON.stringify(rule[0]!.value)).toContain('ext:geo-custom:mycat');
    expect(state.report!.report.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['geo-ext-unresolved', 'geo-not-carried', 'geo-rollout', 'egress-not-converted']));
    // the old settings stay as a reference
    expect((await q(target(), `SELECT 1 FROM app_settings WHERE key IN ('geoSources', 'geoCategories')`)).length).toBe(2);
  });

  it('converts the profile engine, brings the WireGuard profile back, derives the transports', async () => {
    expect((await q(target(), `SELECT 1 FROM profiles WHERE engine = 'mtproto'`)).length).toBe(0);
    expect((await q<{ engine: string | null }>(target(), `SELECT engine FROM profiles WHERE name = 'mtg'`))[0]!.engine).toBeNull();
    expect((await q<{ engine: string | null }>(target(), `SELECT engine FROM profiles WHERE name = 'mtproxy'`))[0]!.engine).toBe('mtprotoproxy');
    expect((await q<{ protocol: string }>(target(), `SELECT protocol FROM profiles WHERE name = 'wg'`))[0]!.protocol).toBe('wireguard');
    expect((await q<{ transport: string }>(target(), `SELECT b.transport FROM profile_node_bindings b JOIN profiles p ON p.id = b.profile_id WHERE p.name = 'wg'`))[0]!.transport).toBe('udp');
    expect((await q(target(), `SELECT 1 FROM information_schema.tables WHERE table_name = 'fork_migration_wg_profiles'`)).length).toBe(0);
  });

  it('cuts the user agent to 512 and keeps the unique WireGuard key', async () => {
    const lens = await q<{ m: number }>(target(), `SELECT max(length(user_agent)) AS m FROM hwid_user_devices`);
    expect(lens[0]!.m).toBe(512);
    const t = await q<{ data_type: string; character_maximum_length: number }>(target(), `SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'hwid_user_devices' AND column_name = 'user_agent'`);
    expect(t[0]).toEqual({ data_type: 'character varying', character_maximum_length: 512 });
    await expect(q(target(), `UPDATE wg_devices SET public_key = (SELECT public_key FROM wg_devices ORDER BY id LIMIT 1) WHERE id = (SELECT id FROM wg_devices ORDER BY id DESC LIMIT 1)`)).rejects.toThrow(/wg_devices_public_key_key/);
  });

  it('is read by the schemas of the new panel: profiles, bindings, hosts, settings, rules, hardening', async () => {
    const r = await withClient(target(), (c) => checkStoredContent(c));
    expect(r.problems).toEqual([]);
    expect(r.checked).toMatchObject({ profiles: 10, bindings: 11, hosts: 2 });
    // what the schema drops silently is still listed: the Hysteria pin
    expect(r.strippedKeys).toEqual([{ profile: 'hy2', protocol: 'hysteria', keys: ['pinnedPeerCertSha256'] }]);
  });

  it('prints, and does not change, the response rules that differ from a fresh install', async () => {
    const srr = state.report!.report.data['srr'] as { differsFromFresh: Array<{ name: string; origin: string }>; notInFreshSeed: string[]; missingFromDatabase: string[] };
    expect(srr.differsFromFresh.map((d) => d.name)).toEqual(expect.arrayContaining(['Clash', 'NekoBox/NekoRay', 'WireGuard', 'v2rayN', 'Happ']));
    expect(srr.differsFromFresh.find((d) => d.name === 'Outline')!.origin).toMatch(/edited by the operator/);
    expect(srr.notInFreshSeed).toEqual(['MyApp']);
    expect(srr.missingFromDatabase).toEqual(['v2rayNG']); // the guard of its migration did not fire: v2rayN was edited
    const clash = await q<{ format: string }>(target(), `SELECT format FROM subscription_response_rules WHERE name = 'Clash'`);
    expect(clash[0]!.format).toBe('clash'); // the fresh install says mihomo: not changed silently
  });

  it('swaps in and out: the old database is kept, a second move on the moved installation is refused', async () => {
    const live = state.source!;
    const swapped = await swapIn(state.url!, state.target);
    expect(swapped).toEqual({ live, pre: `${live}_pre_fork` });
    const moved = await q<{ n: string }>(withDatabase(URL, live), `SELECT count(*)::text AS n FROM _prisma_migrations`);
    expect(moved[0]!.n).toBe(String(omegaMigrationNames().length));
    expect(codes(await runPrecheck({ databaseUrl: withDatabase(URL, live), acceptLoss: false, env: ENV }))).toEqual(['already-migrated']);
    await expect(swapIn(state.url!, state.target)).rejects.toThrow(/no migrated copy|already exists/);

    const back = await swapBack(state.url!);
    expect(back.live).toBe(live);
    expect((await q<{ n: string }>(withDatabase(URL, live), `SELECT count(*)::text AS n FROM _prisma_migrations`))[0]!.n).toBe('65');
    // and a second run, from the returned installation, goes through
    const again = await runMigration({ databaseUrl: withDatabase(URL, live), acceptLoss: false, env: ENV, log: () => {} });
    expect(again.report.steps.find((s) => s.step === 'verify')!.status).toBe('done');
  }, 120_000);
});

describe('--accept-loss', () => {
  it('moves a profile with post-quantum fields, takes the fields out and keeps every other secret', async () => {
    const db = await dbs.copy('filled');
    await q(db.url, `UPDATE profiles SET config = config || '{"vlessDecryption":"mlkem768x25519plus.x","vlessEncryption":"mlkem768x25519plus.y","abusePolicy":{"blockTorrent":true}}'::jsonb WHERE name = 'reality'`);
    await expect(runMigration({ databaseUrl: db.url, acceptLoss: false, env: ENV, log: () => {} })).rejects.toBeInstanceOf(BlockedError);
    const r = await runMigration({ databaseUrl: db.url, acceptLoss: true, env: ENV, log: () => {} });
    const cfg = await q<{ config: Record<string, unknown> }>(withDatabase(URL, r.target), `SELECT config FROM profiles WHERE name = 'reality'`);
    expect(Object.keys(cfg[0]!.config)).not.toEqual(expect.arrayContaining(['vlessDecryption']));
    expect(cfg[0]!.config['realityDest']).toBe('www.microsoft.com:443');
    expect(r.report.data['lossApplied']).toEqual([{ where: 'profile', name: 'reality', removed: expect.arrayContaining(['vlessDecryption', 'vlessEncryption', 'abusePolicy']) }]);
  }, 120_000);
});

describe('an installation with nothing in it but the seeds', () => {
  it('moves too (a fresh old-fork install)', async () => {
    const db = await dbs.copy('empty');
    const r = await runMigration({ databaseUrl: db.url, acceptLoss: false, env: ENV, log: () => {} });
    expect(r.report.steps.find((s) => s.step === 'verify')!.status).toBe('done');
    expect((await schemaDiff(withDatabase(URL, r.target), OMEGA_SCHEMA())).equal).toBe(true);
  }, 120_000);
});
