import type { NodePolicy as WireNodePolicy, NodePolicyRule as WireRule } from '@iceslab/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../prisma.js';
import { eventBus } from '../../lib/infra/event-bus.js';
import { mapPolicy, type NodePolicyDto } from './node-policies.mapper.js';
import { directionOfRouteTag, policyCascadeOutTag, type CascadeXrayDrawing } from '../cascades/cascade.config.js';
import { cascadeEntryGate, type CascadeEntryGate } from '../cascades/cascade.service.js';
import { splitPolicyEntries } from '../cascades/policy-entries.js';
import { isPortList, POLICY_PROTOCOLS } from './node-policies.schemas.js';
import { getLogger } from '../../lib/infra/logger.js';
import type {
  CreateNodePolicyInput,
  PolicyRuleInput,
  UpdateNodePolicyInput,
} from './node-policies.schemas.js';

export class NodePolicyNotFoundError extends Error {
  constructor(public id: string) {
    super(`Node policy ${id} not found`);
    this.name = 'NodePolicyNotFoundError';
  }
}

export class NodePolicyNameTakenError extends Error {
  constructor(public name: string) {
    super(`A node policy named "${name}" already exists`);
    this.name = 'NodePolicyNameTakenError';
  }
}

export class DirectionNotFoundError extends Error {
  constructor(public directionId: string) {
    super(`Cascade direction ${directionId} not found`);
    this.name = 'DirectionNotFoundError';
  }
}

/**
 * A policy cannot be rendered on a node that has nowhere to send the traffic.
 *
 * Raised at SAVE time rather than left to the push. The node would refuse the
 * config too (xray validates its own tags and the outbound simply is not
 * there), but that failure arrives minutes later, in a worker log, attached to
 * a node rather than to the rule the operator just wrote.
 */
export class PolicyDoesNotFitNodeError extends Error {
  constructor(
    public nodeName: string,
    public reason: string,
  ) {
    super(`Node "${nodeName}" cannot run this policy: ${reason}`);
    this.name = 'PolicyDoesNotFitNodeError';
  }
}

const RULE_INCLUDE = {
  rules: {
    orderBy: { position: 'asc' },
    include: {
      direction: { select: { id: true, tag: true, countryCode: true } },
    },
  },
} satisfies Prisma.NodePolicyInclude;

export async function listPolicies(): Promise<NodePolicyDto[]> {
  const rows = await prisma.nodePolicy.findMany({
    include: { ...RULE_INCLUDE, _count: { select: { nodes: true } } },
    orderBy: { name: 'asc' },
  });
  return rows.map((p) => mapPolicy(p, p._count.nodes));
}

export async function getPolicy(id: string): Promise<NodePolicyDto> {
  const p = await prisma.nodePolicy.findUnique({
    where: { id },
    include: { ...RULE_INCLUDE, _count: { select: { nodes: true } } },
  });
  if (!p) throw new NodePolicyNotFoundError(id);
  return mapPolicy(p, p._count.nodes);
}

export async function createPolicy(input: CreateNodePolicyInput): Promise<NodePolicyDto> {
  await assertDirectionsExist(input.rules);
  try {
    const created = await prisma.nodePolicy.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        rules: { create: input.rules.map(toRuleRow) },
      },
      include: RULE_INCLUDE,
    });
    return mapPolicy(created, 0);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new NodePolicyNameTakenError(input.name);
    }
    throw err;
  }
}

export async function updatePolicy(
  id: string,
  input: UpdateNodePolicyInput,
): Promise<NodePolicyDto> {
  const existing = await prisma.nodePolicy.findUnique({
    where: { id },
    select: { id: true, nodes: { select: { id: true } } },
  });
  if (!existing) throw new NodePolicyNotFoundError(id);
  if (input.rules) await assertDirectionsExist(input.rules);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.nodePolicy.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      });
      if (input.rules) {
        // Replaced wholesale rather than diffed: a policy IS its ordered list,
        // the screen edits all of it, and rebuilding is the only way a reorder
        // and a deletion in the same save cannot half-apply.
        await tx.nodePolicyRule.deleteMany({ where: { policyId: id } });
        for (const [position, rule] of input.rules.entries()) {
          await tx.nodePolicyRule.create({
            data: { policyId: id, ...toRuleRow(rule, position) },
          });
        }
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new NodePolicyNameTakenError(input.name ?? '');
    }
    throw err;
  }

  // Every node running this policy now serves different rules, so each needs a
  // push. Checked BEFORE announcing, so a policy that no longer fits a node it
  // is attached to is refused here rather than on the node.
  for (const node of existing.nodes) await assertPolicyFitsNode(id, node.id);
  if (existing.nodes.length > 0) {
    eventBus.emit('policy.changed', { policyId: id, nodeIds: existing.nodes.map((n) => n.id) });
  }

  return getPolicy(id);
}

export async function deletePolicy(id: string): Promise<void> {
  const existing = await prisma.nodePolicy.findUnique({
    where: { id },
    select: { nodes: { select: { id: true } } },
  });
  if (!existing) throw new NodePolicyNotFoundError(id);
  // SET NULL on the node side: the nodes go back to no policy, which is a state
  // they can be in, and each of them needs its config rewritten without it.
  await prisma.nodePolicy.delete({ where: { id } });
  if (existing.nodes.length > 0) {
    eventBus.emit('policy.changed', { policyId: id, nodeIds: existing.nodes.map((n) => n.id) });
  }
}

function toRuleRow(rule: PolicyRuleInput, position?: number) {
  return {
    position: position ?? 0,
    enabled: rule.enabled,
    matchDomain: rule.match.domain,
    matchIp: rule.match.ip,
    matchPort: rule.match.port ?? null,
    matchProtocol: rule.match.protocol,
    matchNetwork: rule.match.network ?? null,
    actionKind: rule.action.kind,
    actionDirectionId: rule.action.directionId ?? null,
  };
}

/** A direction id that names nothing is a rule pointing at a way out that does
 *  not exist. The FK would catch it, but with a message about a constraint. */
async function assertDirectionsExist(rules: PolicyRuleInput[]): Promise<void> {
  const ids = [
    ...new Set(rules.map((r) => r.action.directionId).filter((v): v is string => !!v)),
  ];
  if (ids.length === 0) return;
  const found = await prisma.cascadeDirection.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const seen = new Set(found.map((d) => d.id));
  const missing = ids.find((id) => !seen.has(id));
  if (missing) throw new DirectionNotFoundError(missing);
}

/**
 * Can this node actually carry out this policy?
 *
 * Two things it can fail on, and both produce a config the core refuses rather
 * than traffic going somewhere unexpected, which is why they are worth catching
 * at the save instead:
 *
 *   - a WARP rule on a node with no WARP egress provisioned;
 *   - a cascade rule naming a direction this node has no leg to.
 *
 * The second also rejects a direction whose pool this node reaches through MORE
 * than one leg. The rendered policy names ONE outbound, and with two legs there
 * is no single honest answer: picking the first would quietly send every
 * matching connection through half of a pool the operator built for redundancy.
 * Balancing across a direction needs a per-direction balancer and a wire field
 * to target it, which is its own change.
 */
export async function assertPolicyFitsNode(policyId: string, nodeId: string): Promise<void> {
  const [policy, node] = await Promise.all([
    prisma.nodePolicy.findUnique({
      where: { id: policyId },
      include: { rules: { include: { direction: { select: { id: true, tag: true, cascadeId: true } } } } },
    }),
    prisma.node.findFirst({
      where: { id: nodeId, deletedAt: null },
      select: { id: true, name: true, warpEnabled: true },
    }),
  ]);
  if (!policy || !node) return;

  for (const rule of policy.rules) {
    if (!rule.enabled) continue;
    if (rule.actionKind === 'warp' && !node.warpEnabled) {
      throw new PolicyDoesNotFitNodeError(
        node.name,
        'it has a rule routing into WARP, and WARP egress is not enabled on this node',
      );
    }
    if (rule.actionKind === 'cascade' && rule.direction) {
      const legs = await prisma.cascadeLink.count({
        where: {
          cascadeId: rule.direction.cascadeId,
          fromNodeId: node.id,
          directionTag: rule.direction.tag,
        },
      });
      if (legs === 0) {
        throw new PolicyDoesNotFitNodeError(
          node.name,
          `it has a rule going out through a cascade direction this node does not dial`,
        );
      }
      if (legs > 1) {
        throw new PolicyDoesNotFitNodeError(
          node.name,
          `it has a rule going out through a cascade direction this node reaches by ${legs} links; ` +
            `a policy rule names one outbound, so pooled directions are not supported yet`,
        );
      }
    }
  }
}

/**
 * The policy this node should be running, in wire shape.
 *
 * Direction ids become outbound names HERE, in the same push that prints the
 * cascade fragments those outbounds come from. That is the whole reason the id
 * is what gets stored: the name is only true relative to one rendering.
 *
 * A-108: and relative to WHICH rendering. `drawing` is the one this push gives
 * the node's xray (policyCascadeOutTag); the name came from the legacy one
 * alone, and every entry under a chain got a rule to an outbound its config did
 * not have. A drawing with no way out of the cascade drops the rule, as a
 * direction the node does not dial does: naming an outbound that is not in the
 * config would make the core reject the whole push. Default `legacy`: a caller
 * that renders no xray cascade (the exit's chain) skips these rules anyway.
 *
 * Returns undefined when the node has no policy, which is the normal state and
 * renders on the node exactly as before the field existed.
 */
export async function resolvePolicyForNode(
  nodeId: string,
  drawing: CascadeXrayDrawing = 'legacy',
): Promise<WireNodePolicy | undefined> {
  return (await explainPolicyForNode(nodeId, drawing)).policy;
}

/** A-232: the node's own report about the policy, as /policy-drawing shows it. */
export interface AgentPolicyReport {
  drawing: 'legacy' | 'handover' | 'none';
  /** Each rule the node's xray left out, with the policy rules it stands for;
   *  `ruleIds` empty when no rule of the current policy names that way out
   *  (the policy changed since): the exit is kept, not lost. */
  notDrawn: { exit: string; direction: number; ruleIds: string[] }[];
  /** When xray accepted the render, by the node's clock. */
  renderedAt: string;
  /** When the panel last saw the report, by its own clock. */
  observedAt: string;
}

/**
 * The agent's report stored by the poll (nodes.policy_drawn), its exits put
 * back on the rules of the node's policy by the names the panel prints
 * (policyCascadeOutTag, either drawing). null for a node whose agent has not
 * reported: an older agent, never "nothing left out".
 */
export async function agentPolicyReportForNode(nodeId: string): Promise<AgentPolicyReport | null> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: {
      policyDrawn: true,
      policy: {
        select: {
          rules: {
            where: { actionKind: 'cascade' },
            select: { id: true, direction: { select: { tag: true } } },
          },
        },
      },
    },
  });
  const stored = node?.policyDrawn as
    | { drawing: AgentPolicyReport['drawing']; notDrawn: { exit: string; direction: number }[]; renderedAt: string; observedAt: string }
    | null
    | undefined;
  if (!stored) return null;
  const rules = node?.policy?.rules ?? [];
  return {
    drawing: stored.drawing,
    notDrawn: (stored.notDrawn ?? []).map((d) => ({
      exit: d.exit,
      direction: d.direction,
      ruleIds: rules
        .filter(
          (r) =>
            r.direction &&
            (policyCascadeOutTag(r.direction.tag, 'legacy') === d.exit ||
              policyCascadeOutTag(r.direction.tag, 'handover') === d.exit),
        )
        .map((r) => r.id),
    })),
    renderedAt: stored.renderedAt,
    observedAt: stored.observedAt,
  };
}

/**
 * Why a rule of the node's policy does not reach the node (A-232):
 *   - `lost-condition`: a whole kind of its matchers is unreadable (A-103);
 *   - `direction-not-dialled`: the node dials the rule's direction by no leg,
 *     or by more than one (a pooled direction, not supported by a rule);
 *   - `no-cascade-drawing`: the push gives xray no way out of the cascade (a
 *     transit or exit under a chain, an entry on hysteria or AmneziaWG);
 *   - `nobody-may-take` (A-277): no user of this entry may take the rule's
 *     direction (a squad narrowed elsewhere, the cascade switched off for it),
 *     so the rule would only open the way to the users its door keeps out.
 */
export type PolicyNotDrawnReason = 'lost-condition' | 'direction-not-dialled' | 'no-cascade-drawing' | 'nobody-may-take';
export interface PolicyRuleNotDrawn {
  ruleId: string;
  reason: PolicyNotDrawnReason;
}

/**
 * A-277: who a rule into direction N lets through at an xray entry: whoever
 * may take ANY tag of N, the plain one or a route policy's variant of it
 * (routeTag(ordinal, N - 1)); a user granted only the variant still reaches N
 * through its door. Auto names no direction and counts for none. Sorted.
 */
export function usersForDirection(allowedTagsOf: Map<string, Set<number>>, directionTag: number): string[] {
  return [...allowedTagsOf]
    .filter(([, tags]) => [...tags].some((t) => directionOfRouteTag(t) === directionTag))
    .map(([u]) => u)
    .sort();
}

/**
 * The policy as the push sends it, and every rule left out with why. ONE loop:
 * the read that shows the operator which rules do not act here and the push
 * cannot tell two stories. ⚠ By the drawing the panel SENDS (cascadeXrayDrawingOf);
 * an agent whose chain was refused draws another one and may rename or drop a
 * cascade rule there (fitCascadeExits), which only its journal shows.
 *
 * A-277: a rule into a cascade direction lets through the users the door of
 * that direction lets through (cascadeEntryGate, the doors' own computation),
 * as `users` on its action. Before, it sat above the doors with no user and
 * took a squad the cascade was switched off for into it (stand, 26.10).
 * `ungated` names the rules drawn for everybody because the entry cannot tell
 * its users apart (hysteria, AmneziaWG: they arrive through the chain).
 */
export async function explainPolicyForNode(
  nodeId: string,
  drawing: CascadeXrayDrawing = 'legacy',
): Promise<{ policy: WireNodePolicy | undefined; notDrawn: PolicyRuleNotDrawn[]; ungated: string[] }> {
  const notDrawn: PolicyRuleNotDrawn[] = [];
  const ungated: string[] = [];
  const gates = new Map<string, Promise<CascadeEntryGate>>();
  const gateOf = (cascadeId: string) =>
    gates.get(cascadeId) ?? gates.set(cascadeId, cascadeEntryGate(nodeId, cascadeId)).get(cascadeId)!;
  const node = await prisma.node.findFirst({
    where: { id: nodeId, deletedAt: null },
    select: {
      policy: {
        include: {
          rules: {
            where: { enabled: true },
            orderBy: { position: 'asc' },
            include: { direction: { select: { tag: true, cascadeId: true } } },
          },
        },
      },
    },
  });
  if (!node?.policy) return { policy: undefined, notDrawn, ungated };

  const rules: WireRule[] = [];
  for (const r of node.policy.rules) {
    // A-103: only what an engine reads goes out, each entry in its own list. A
    // row saved before the save checked its matchers can hold a `geoip:` among
    // the domains or a port with an en dash; xray refused the whole config on
    // it, the chain dropped it. A rule whose every condition is unreadable is
    // left out entirely: dropping its conditions would make it a rule on all
    // traffic, the opposite of what the operator wrote.
    const domain = splitPolicyEntries(r.matchDomain).domain;
    const ip = splitPolicyEntries(r.matchIp).ip;
    const port = r.matchPort && isPortList(r.matchPort) ? r.matchPort : undefined;
    const protocol = r.matchProtocol.filter((p) => (POLICY_PROTOCOLS as readonly string[]).includes(p));
    // The kinds of condition AND together (domains AND addresses AND port AND
    // protocol), in xray's rule and in the chain's. So losing a WHOLE kind
    // widens the rule as much as losing all of them: "block, domain:
    // [geoip:xx], port: 443" would go out as "block all of 443". A rule that
    // lost any kind it was written with is left out; losing some entries
    // inside one kind (they OR) only narrows it, and that stays.
    const lost = [
      r.matchDomain.length > 0 && domain.length === 0 ? 'domain' : null,
      r.matchIp.length > 0 && ip.length === 0 ? 'ip' : null,
      r.matchPort && !port ? 'port' : null,
      r.matchProtocol.length > 0 && protocol.length === 0 ? 'protocol' : null,
    ].filter((k): k is string => k !== null);
    if (lost.length > 0) {
      getLogger().warn(
        { nodeId, ruleId: r.id, lost },
        '[node-policy] a rule that lost a whole kind of condition is left out, not widened to more traffic',
      );
      notDrawn.push({ ruleId: r.id, reason: 'lost-condition' });
      continue;
    }
    const match: WireRule['match'] = {};
    if (domain.length) match.domain = domain;
    if (ip.length) match.ip = ip;
    if (port) match.port = port;
    if (protocol.length) match.protocol = protocol;
    if (r.matchNetwork) match.network = r.matchNetwork as WireRule['match']['network'];

    if (r.actionKind === 'cascade') {
      if (!r.direction) {
        notDrawn.push({ ruleId: r.id, reason: 'direction-not-dialled' });
        continue;
      }
      const legs = await prisma.cascadeLink.findMany({
        where: {
          cascadeId: r.direction.cascadeId,
          fromNodeId: nodeId,
          directionTag: r.direction.tag,
        },
        select: { id: true },
      });
      // Skipped rather than rendered when the node cannot reach the direction.
      // Saving already refuses this, so reaching it means the topology changed
      // underneath; naming an outbound that is not in the config would make the
      // core reject the WHOLE push and take the node's other inbounds with it.
      if (legs.length !== 1) {
        notDrawn.push({ ruleId: r.id, reason: 'direction-not-dialled' });
        continue;
      }
      const exit = policyCascadeOutTag(r.direction.tag, drawing);
      if (!exit) {
        notDrawn.push({ ruleId: r.id, reason: 'no-cascade-drawing' });
        continue;
      }
      const gate = await gateOf(r.direction.cascadeId);
      if (gate.kind === 'ungated') ungated.push(r.id);
      if (gate.kind !== 'gate') {
        rules.push({ match, action: { kind: 'cascade', exit } });
        continue;
      }
      const users = usersForDirection(gate.allowedTagsOf, r.direction.tag);
      // Never an empty list: xray drops an empty condition and the rule would
      // match everyone, the leak this closes.
      if (users.length === 0) {
        notDrawn.push({ ruleId: r.id, reason: 'nobody-may-take' });
        continue;
      }
      // The list goes out even when every user of the entry is on it: closed
      // by default, like the door (applyEntryUserGate). A user added later to
      // a squad the cascade is off for is handed to xray by addUser, which
      // does not redraw the rules; without a list the rule would take them
      // into the cascade until the next push.
      rules.push({ match, action: { kind: 'cascade', exit, users } });
      continue;
    }
    rules.push({
      match,
      action: { kind: r.actionKind as 'direct' | 'block' | 'warp' },
    });
  }

  return { policy: { rules }, notDrawn, ungated };
}
