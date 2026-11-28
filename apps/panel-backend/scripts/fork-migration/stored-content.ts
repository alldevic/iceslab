import { CreateBindingSchema, CreateProfileSchema } from '../../src/modules/profiles/profiles.schemas.js';
import { CreateHostSchema } from '../../src/modules/hosts/hosts.schemas.js';
import { CreateSrrSchema } from '../../src/modules/srr/srr.schemas.js';
import { UpdateSettingsSchema } from '../../src/modules/settings/settings.schemas.js';
import { HardeningSchema } from '../../src/modules/nodes/nodes.schemas.js';
import { PolicyRuleSchema } from '../../src/modules/node-policies/node-policies.schemas.js';
import type { Client } from './pgutil.js';
import { columnExists, rows } from './pgutil.js';
import type { Finding } from './report.js';
import { stripHardening } from './transforms/hardening.js';

/**
 * Does the new panel read what is stored? Every profile, binding, host, setting,
 * response rule and node hardening is run through the Zod schema omega validates
 * it with when it is written (profiles.schemas.ts and the others), and what
 * does not parse is named, row by row. The pre-check runs it on the old
 * database, the verification on the migrated one.
 *
 * Unknown keys are not an error to these schemas (they are dropped), which is
 * exactly the danger: strippedKeys lists them, so a field the old fork kept and
 * omega forgets is seen before it is lost.
 */

/** Keys the customer decided against (f09-01, f09-02, f10-01..03): clients holding links built on them break. */
export const LOSSY_KEYS = ['realityMldsa65Seed', 'realityMldsa65Verify', 'vlessDecryption', 'vlessEncryption', 'abusePolicy'] as const;

export interface StoredContentResult {
  problems: Finding[];
  /** profile name -> top-level config keys omega's schema drops. */
  strippedKeys: Array<{ profile: string; protocol: string; keys: string[] }>;
  checked: Record<string, number>;
}

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

function problem(table: string, who: string, issues: Array<{ path: PropertyKey[]; message: string }>): Finding {
  return {
    code: 'stored-content-unreadable',
    message: `${table} "${who}" is not read by the new panel: ${issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    details: { table, who, issues: issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
  };
}

export async function checkStoredContent(c: Client): Promise<StoredContentResult> {
  const res: StoredContentResult = { problems: [], strippedKeys: [], checked: {} };
  const hasAwg = await columnExists(c, 'profiles', 'awg_protocol');

  const profiles = await rows<{ id: string; name: string; protocol: string; description: string | null; enabled: boolean; engine: string | null; config: Record<string, unknown>; awg_protocol?: number | null }>(
    c,
    `SELECT id, name, protocol, description, enabled, engine, config${hasAwg ? ', awg_protocol' : ''} FROM profiles ORDER BY name`,
  );
  for (const p of profiles) {
    // engine 'mtproto' is converted by the profile-engine transform, so it is not a finding of its own here.
    const input = { name: p.name, protocol: p.protocol, description: p.description, enabled: p.enabled, engine: p.engine === 'mtproto' ? null : p.engine, awgProtocol: p.awg_protocol ?? null, config: p.config };
    const parsed = CreateProfileSchema.safeParse(input);
    if (!parsed.success) {
      res.problems.push(problem('profile', p.name, parsed.error.issues));
      continue;
    }
    const out = (parsed.data as { config?: Record<string, unknown> }).config ?? {};
    const keys = Object.keys(p.config ?? {}).filter((k) => !(k in out));
    if (keys.length) res.strippedKeys.push({ profile: p.name, protocol: p.protocol, keys });
  }
  res.checked['profiles'] = profiles.length;

  const bindings = await rows<{ id: string; profile_id: string; node_id: string; port: number; public_host: string | null; public_port: number | null; overrides: Record<string, unknown> | null; enabled: boolean }>(
    c,
    `SELECT id, profile_id, node_id, port, public_host, public_port, overrides, enabled FROM profile_node_bindings`,
  );
  for (const b of bindings) {
    const r = CreateBindingSchema.safeParse({
      profileId: b.profile_id,
      nodeId: b.node_id,
      port: b.port,
      publicHost: b.public_host ?? undefined,
      publicPort: b.public_port ?? undefined,
      overrides: b.overrides ?? undefined,
      enabled: b.enabled,
    });
    if (!r.success) res.problems.push(problem('binding', b.id, r.error.issues));
  }
  res.checked['bindings'] = bindings.length;

  const hosts = await rows<Record<string, unknown>>(c, `SELECT * FROM hosts`);
  for (const h of hosts) {
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(h)) {
      if (['id', 'created_at', 'updated_at', 'source_id'].includes(k)) continue;
      input[camel(k)] = v;
    }
    const r = CreateHostSchema.safeParse(input);
    if (!r.success) res.problems.push(problem('host', String(h['remark'] ?? h['id']), r.error.issues));
  }
  res.checked['hosts'] = hosts.length;

  const rules = await rows<{ name: string; ua_pattern: string; format: string; priority: number; enabled: boolean; proto: string | null }>(
    c,
    `SELECT name, ua_pattern, format, priority, enabled, proto FROM subscription_response_rules`,
  );
  for (const r of rules) {
    const parsed = CreateSrrSchema.safeParse({ name: r.name, uaPattern: r.ua_pattern, format: r.format, priority: r.priority, enabled: r.enabled, proto: r.proto });
    if (!parsed.success) res.problems.push(problem('response rule', r.name, parsed.error.issues));
  }
  res.checked['responseRules'] = rules.length;

  const settings = await rows<{ key: string; value: unknown }>(c, `SELECT key, value FROM app_settings`);
  const shape = UpdateSettingsSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }>;
  let settingsChecked = 0;
  for (const s of settings) {
    const schema = shape[s.key];
    if (!schema) continue;
    settingsChecked++;
    const r = schema.safeParse(s.value);
    if (!r.success) res.problems.push(problem('setting', s.key, r.error?.issues ?? []));
  }
  res.checked['settings'] = settingsChecked;

  const nodes = await rows<{ name: string; hardening: unknown }>(c, `SELECT name, hardening FROM nodes WHERE hardening IS NOT NULL`);
  for (const n of nodes) {
    // The three keys of the old fork are the move's own business (hardening-strip), not a finding.
    const r = HardeningSchema.safeParse(stripHardening(n.hardening)?.next ?? n.hardening);
    if (!r.success) res.problems.push(problem('node hardening', n.name, r.error.issues));
  }
  res.checked['nodeHardening'] = nodes.length;
  return res;
}

/** After the transforms: every rule of every node policy parses (the schema the API applies on a save). */
export async function checkNodePolicies(c: Client): Promise<Finding[]> {
  const out: Finding[] = [];
  const rs = await rows<{ policy: string; match_domain: string[]; match_ip: string[]; match_port: string | null; match_protocol: string[]; match_network: string | null; enabled: boolean; action_kind: string; action_direction_id: string | null }>(
    c,
    `SELECT p.name AS policy, r.match_domain, r.match_ip, r.match_port, r.match_protocol, r.match_network, r.enabled, r.action_kind, r.action_direction_id
       FROM node_policy_rules r JOIN node_policies p ON p.id = r.policy_id`,
  );
  for (const r of rs) {
    const parsed = PolicyRuleSchema.safeParse({
      enabled: r.enabled,
      match: { domain: r.match_domain, ip: r.match_ip, port: r.match_port, protocol: r.match_protocol, network: r.match_network },
      action: { kind: r.action_kind, directionId: r.action_direction_id },
    });
    if (!parsed.success) out.push(problem('node policy rule', r.policy, parsed.error.issues));
  }
  return out;
}
