import type { Client } from '../pgutil.js';
import { rows } from '../pgutil.js';
import type { Report } from '../report.js';
import { step } from '../report.js';
import { convertEgressRules, policyName, type NewPolicyRule } from './egress-convert.js';

/**
 * The old fork's egress policies into node policies of omega (questions 4):
 *  - the policy of a NODE (nodes.hardening.egressPolicy) is converted always;
 *  - the policy of a cascade MEMBER (cascade_position_nodes.egress_policy) only
 *    when the node is in exactly one position and has no policy of its own;
 *  - everything else is written to the report, in full, for the operator.
 * Idempotent: a node that already has a policy is not given a second one.
 */

export interface NotConverted {
  scope: 'node' | 'position';
  node: string;
  nodeId: string;
  cascade?: string;
  position?: number;
  reason: string;
  policy: unknown;
}

interface NodeRow {
  id: string;
  name: string;
  hardening: Record<string, unknown> | null;
  warp_enabled: boolean;
  policy_id: string | null;
}

async function insertPolicy(c: Client, name: string, description: string, rules: NewPolicyRule[]): Promise<string> {
  const p = await c.query(
    `INSERT INTO node_policies (id, name, description, updated_at) VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [name, description],
  );
  const id = (p.rows[0] as { id: string }).id;
  let position = 0;
  for (const r of rules) {
    await c.query(
      `INSERT INTO node_policy_rules
         (id, policy_id, position, enabled, match_domain, match_ip, match_port, match_protocol, match_network, action_kind, action_direction_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, true, $3, $4, $5, $6, $7, $8, $9, now())`,
      [id, position++, r.matchDomain, r.matchIp, r.matchPort, r.matchProtocol, r.matchNetwork, r.actionKind, r.actionDirectionId],
    );
  }
  return id;
}

export async function convertEgressPolicies(c: Client, report: Report): Promise<NotConverted[]> {
  const notConverted: NotConverted[] = [];
  const log = { nodePolicies: 0, positionPolicies: 0, droppedRules: [] as unknown[], convertedRules: 0 };
  const taken = new Set((await rows<{ name: string }>(c, `SELECT name FROM node_policies`)).map((r) => r.name));
  const nodes = await rows<NodeRow>(c, `SELECT id, name, hardening, warp_enabled, policy_id FROM nodes ORDER BY created_at, id`);
  const policyOfNode = new Map(nodes.map((n) => [n.id, n.policy_id]));

  // Node scope. Directions are not reachable from here (a node policy names no direction).
  for (const n of nodes) {
    const raw = n.hardening?.['egressPolicy'];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    if (n.policy_id) {
      notConverted.push({ scope: 'node', node: n.name, nodeId: n.id, reason: 'the node already runs a policy of omega', policy: raw });
      continue;
    }
    const res = convertEgressRules(raw, { scope: 'node', warpEnabled: n.warp_enabled, directionIdByTag: new Map(), legsToDirection: () => 0 });
    res.dropped.forEach((d) => log.droppedRules.push({ node: n.name, scope: 'node', ...d }));
    if (res.refused.length > 0) {
      notConverted.push({ scope: 'node', node: n.name, nodeId: n.id, reason: res.refused.map((r) => `rule ${r.index}: ${r.reason}`).join('; '), policy: raw });
      continue;
    }
    if (res.rules.length === 0) continue;
    const name = policyName(n.name, taken);
    taken.add(name);
    const id = await insertPolicy(c, name, `Carried over from the old fork: the egress policy of node "${n.name}".`, res.rules);
    await c.query(`UPDATE nodes SET policy_id = $1 WHERE id = $2`, [id, n.id]);
    policyOfNode.set(n.id, id);
    log.nodePolicies++;
    log.convertedRules += res.rules.length;
  }

  // Position scope.
  const members = await rows<{
    node_id: string;
    position_id: string;
    egress_policy: unknown;
    cascade_id: string;
    cascade: string;
    position: number;
  }>(
    c,
    `SELECT pn.node_id, pn.position_id, pn.egress_policy, p.cascade_id, c.name AS cascade, p."position"
       FROM cascade_position_nodes pn
       JOIN cascade_positions p ON p.id = pn.position_id
       JOIN cascades c ON c.id = p.cascade_id
      ORDER BY c.name, p."position"`,
  );
  const memberships = new Map<string, number>();
  for (const m of members) memberships.set(m.node_id, (memberships.get(m.node_id) ?? 0) + 1);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const m of members) {
    if (!Array.isArray(m.egress_policy) || m.egress_policy.length === 0) continue;
    const n = nodeById.get(m.node_id);
    if (!n) continue;
    const where = { node: n.name, nodeId: n.id, cascade: m.cascade, position: m.position, policy: m.egress_policy };
    if ((memberships.get(n.id) ?? 0) !== 1) {
      notConverted.push({ scope: 'position', ...where, reason: `the node is in ${memberships.get(n.id)} positions; one node policy cannot say which hop a rule is for` });
      continue;
    }
    if (policyOfNode.get(n.id)) {
      notConverted.push({ scope: 'position', ...where, reason: 'the node already has a policy (its own); a node runs one' });
      continue;
    }
    const dirs = await rows<{ id: string; tag: number }>(c, `SELECT id, tag FROM cascade_directions WHERE cascade_id = $1`, [m.cascade_id]);
    const legs = await rows<{ direction_tag: number; n: string }>(
      c,
      `SELECT direction_tag, count(*)::text AS n FROM cascade_links WHERE cascade_id = $1 AND from_node_id = $2 GROUP BY direction_tag`,
      [m.cascade_id, n.id],
    );
    const idByTag = new Map(dirs.map((d) => [d.tag, d.id]));
    const tagById = new Map(dirs.map((d) => [d.id, d.tag]));
    const legsByTag = new Map(legs.map((l) => [l.direction_tag, Number(l.n)]));
    const res = convertEgressRules(m.egress_policy, {
      scope: 'position',
      warpEnabled: n.warp_enabled,
      directionIdByTag: idByTag,
      legsToDirection: (id) => legsByTag.get(tagById.get(id) ?? -1) ?? 0,
    });
    res.dropped.forEach((d) => log.droppedRules.push({ node: n.name, scope: 'position', cascade: m.cascade, ...d }));
    if (res.refused.length > 0) {
      notConverted.push({ scope: 'position', ...where, reason: res.refused.map((r) => `rule ${r.index}: ${r.reason}`).join('; ') });
      continue;
    }
    if (res.rules.length === 0) continue;
    const name = policyName(`${n.name}-${m.cascade}`, taken);
    taken.add(name);
    const id = await insertPolicy(
      c,
      name,
      `Carried over from the old fork: the egress policy of node "${n.name}" in cascade "${m.cascade}", position ${m.position}. It applied to that hop only; now it applies to the whole node.`,
      res.rules,
    );
    await c.query(`UPDATE nodes SET policy_id = $1 WHERE id = $2`, [id, n.id]);
    policyOfNode.set(n.id, id);
    log.positionPolicies++;
    log.convertedRules += res.rules.length;
  }

  step(report, {
    step: 'egress-policies',
    status: 'done',
    summary: `${log.nodePolicies} node policies and ${log.positionPolicies} position policies converted (${log.convertedRules} rules); ${log.droppedRules.length} rules dropped as the old compiler dropped them; ${notConverted.length} policies left to the operator`,
    details: log,
  });
  return notConverted;
}
