import type { Client } from './pgutil.js';
import { ident, one, rows } from './pgutil.js';

/** Row counts and checksums of what must not change, taken on either database. */

/** table -> [ordering column(s), columns hashed]. The secrets and the identities. */
export const CHECKSUMS: Record<string, { order: string; columns: string[] }> = {
  users: {
    order: 'id',
    columns: ['id', 'username', 'subscription_token', 'short_id', 'xray_uuid', 'numeric_id', 'hysteria_password', 'naive_password', 'amneziawg_private_key', 'amneziawg_public_key', 'external_squad_uuid', 'status', 'expire_at', 'traffic_limit_bytes'],
  },
  wg_devices: { order: 'id', columns: ['id', 'user_id', 'private_key', 'public_key', 'preshared_key', 'revoked_at'] },
  amneziawg_peers: { order: 'id', columns: ['id', 'profile_id', 'user_id', 'ip', 'device_id'] },
  api_tokens: { order: 'id', columns: ['id', 'name', 'token_hash', 'scopes'] },
  keygen_ca: { order: 'id', columns: ['id', 'cert_pem', 'private_key_pem', 'panel_client_cert_pem', 'panel_client_key_pem'] },
  admin_users: { order: 'id', columns: ['id', 'username', 'password_hash', 'totp_secret', 'totp_enabled'] },
  nodes: { order: 'id', columns: ['id', 'name', 'address', 'heartbeat_secret', 'public_key', 'protocol'] },
  node_bootstrap_tokens: { order: 'id', columns: ['id'] },
  groups: { order: 'id', columns: ['id', 'name', 'routing_preset', 'hwid_device_limit'] },
  profiles: { order: 'id', columns: ['id', 'name', 'protocol', 'config', 'enabled'] },
  hwid_user_devices: { order: 'id', columns: ['id', 'user_id', 'hwid', 'platform', 'os_version', 'device_model'] },
};

export async function rowCounts(c: Client): Promise<Record<string, number>> {
  const tables = await rows<{ table_name: string }>(
    c,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
  );
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = Number((await one<{ n: string }>(c, `SELECT count(*)::text AS n FROM ${ident(t.table_name)}`))?.n ?? 0);
  return out;
}

async function hasColumn(c: Client, table: string, column: string): Promise<boolean> {
  return !!(await one(c, `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]));
}

/** md5 over the rows in key order; a column a database lacks is left out of both sides alike (the caller compares the common ones). */
export async function checksums(c: Client, only?: Record<string, string[]>): Promise<Record<string, { md5: string; rows: number }>> {
  const out: Record<string, { md5: string; rows: number }> = {};
  for (const [table, def] of Object.entries(CHECKSUMS)) {
    const exists = await one(c, `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [table]);
    if (!exists) continue;
    const cols = (only?.[table] ?? def.columns).filter((x) => x);
    const present: string[] = [];
    for (const col of cols) if (await hasColumn(c, table, col)) present.push(col);
    if (present.length === 0) continue;
    const expr = present.map((col) => `coalesce(${ident(col)}::text, '~')`).join(` || '|' || `);
    const r = await one<{ md5: string; n: string }>(
      c,
      `SELECT md5(coalesce(string_agg(${expr}, E'\\n' ORDER BY ${ident(def.order)}), '')) AS md5, count(*)::text AS n FROM ${ident(table)}`,
    );
    out[table] = { md5: r?.md5 ?? '', rows: Number(r?.n ?? 0) };
  }
  return out;
}

/** The sequence behind users.numeric_id: what the next user gets. */
export async function numericIdSequence(c: Client): Promise<string | null> {
  const r = await one<{ seq: string | null }>(c, `SELECT pg_get_serial_sequence('users', 'numeric_id') AS seq`);
  if (!r?.seq) return null;
  const v = await one<{ last_value: string; is_called: boolean }>(c, `SELECT last_value::text, is_called FROM ${r.seq}`);
  return v ? `${v.last_value}/${v.is_called}` : null;
}
