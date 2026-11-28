import { PolicyRuleSchema } from '../../../src/modules/node-policies/node-policies.schemas.js';

/**
 * The old fork's egress language (modules/egress/egress.policy.ts at 040410ac:
 * match -> target rules, on a node and on a cascade member) turned into the
 * rows of a node policy of omega. Pure: no database, so the rules of the
 * conversion are tested on JSON as the old fork stored it.
 *
 * Two meanings are kept: matchers of one rule are "any of" in the old compile
 * (domains and addresses went into separate xray rules), "all of" in omega, so
 * a rule with both kinds becomes two rows; and a rule the OLD compiler dropped
 * for the scope it ran in is dropped here, with the reason, because writing it
 * would make the node do something the old node did not.
 */

export interface OldEgressRule {
  geosite?: string[];
  geoip?: string[];
  domain?: string[];
  ip?: string[];
  port?: string;
  network?: 'tcp' | 'udp' | 'tcp,udp';
  target: 'direct' | 'block' | 'warp' | 'zapret2' | 'link-out' | 'direction';
  directionTag?: number;
}

export interface NewPolicyRule {
  enabled: true;
  matchDomain: string[];
  matchIp: string[];
  matchPort: string | null;
  matchProtocol: string[];
  matchNetwork: string | null;
  actionKind: 'direct' | 'block' | 'warp' | 'cascade';
  actionDirectionId: string | null;
}

export interface ConvertContext {
  /** node: the policy of the node itself; position: of one hop of one chain. */
  scope: 'node' | 'position';
  warpEnabled: boolean;
  /** The cascade's directions by their frozen tag (position scope only). */
  directionIdByTag: ReadonlyMap<number, string>;
  /** How many links of the cascade this node dials into the direction. */
  legsToDirection: (directionId: string) => number;
}

export interface ConvertResult {
  rules: NewPolicyRule[];
  /** Rules the old compiler would not have rendered either: nothing lost. */
  dropped: { index: number; reason: string }[];
  /** Rules omega cannot say. Any of these and the whole policy is left to the operator. */
  refused: { index: number; reason: string }[];
}

const TARGETS = new Set(['direct', 'block', 'warp', 'zapret2', 'link-out', 'direction']);
const qualify = (prefix: string, v: string): string => (v.includes(':') ? v : `${prefix}:${v}`);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function convertEgressRules(raw: unknown, ctx: ConvertContext): ConvertResult {
  const out: ConvertResult = { rules: [], dropped: [], refused: [] };
  if (!Array.isArray(raw)) {
    out.refused.push({ index: -1, reason: 'the stored policy is not a list of rules' });
    return out;
  }
  raw.forEach((item: unknown, index) => {
    const r = (item ?? {}) as Partial<OldEgressRule>;
    if (typeof r !== 'object' || typeof r.target !== 'string' || !TARGETS.has(r.target)) {
      out.refused.push({ index, reason: `unknown target "${String((r as { target?: unknown }).target)}"` });
      return;
    }
    let action: Pick<NewPolicyRule, 'actionKind' | 'actionDirectionId'>;
    switch (r.target) {
      case 'zapret2':
        out.dropped.push({ index, reason: 'zapret2 is not carried over (customer decision)' });
        return;
      case 'link-out':
        if (ctx.scope === 'node') {
          out.dropped.push({ index, reason: 'link-out is served by a cascade hop only; a node policy never rendered it' });
        } else {
          out.refused.push({ index, reason: 'link-out ("the way the client chose") has no action in a node policy' });
        }
        return;
      case 'direction': {
        if (ctx.scope === 'node') {
          out.dropped.push({ index, reason: 'a direction is a cascade way out; a node policy never rendered it' });
          return;
        }
        const id = r.directionTag === undefined ? undefined : ctx.directionIdByTag.get(r.directionTag);
        if (!id) {
          out.dropped.push({ index, reason: `direction tag ${String(r.directionTag)} names no direction of the cascade` });
          return;
        }
        const legs = ctx.legsToDirection(id);
        if (legs !== 1) {
          out.dropped.push({
            index,
            reason: legs === 0 ? 'the node has no link into that direction' : `the node reaches that direction by ${legs} links (a policy rule names one outbound)`,
          });
          return;
        }
        action = { actionKind: 'cascade', actionDirectionId: id };
        break;
      }
      case 'warp':
        if (!ctx.warpEnabled) {
          out.dropped.push({ index, reason: 'WARP is not enabled on the node' });
          return;
        }
        action = { actionKind: 'warp', actionDirectionId: null };
        break;
      default:
        action = { actionKind: r.target, actionDirectionId: null };
    }

    const domains = [...strings(r.geosite).map((v) => qualify('geosite', v)), ...strings(r.domain)];
    const ips = [...strings(r.geoip).map((v) => qualify('geoip', v)), ...strings(r.ip)];
    const port = typeof r.port === 'string' && r.port !== '' ? r.port : null;
    const network = typeof r.network === 'string' ? r.network : null;
    // "Any of" -> one row per kind; a rule of a port alone is one row.
    const sides: Array<[string[], string[]]> = domains.length && ips.length ? [[domains, []], [[], ips]] : [[domains, ips]];
    for (const [d, i] of sides) {
      const row: NewPolicyRule = {
        enabled: true,
        matchDomain: d,
        matchIp: i,
        matchPort: port,
        matchProtocol: [],
        matchNetwork: network,
        ...action,
      };
      const parsed = PolicyRuleSchema.safeParse({
        enabled: true,
        match: { domain: d, ip: i, port, protocol: [], network },
        action: { kind: row.actionKind, directionId: row.actionDirectionId },
      });
      if (!parsed.success) {
        out.refused.push({ index, reason: parsed.error.issues.map((x) => x.message).join('; ').slice(0, 300) });
        continue;
      }
      out.rules.push(row);
    }
  });
  return out;
}

/** A policy name that fits NodePolicy.name (64) and is not taken. */
export function policyName(base: string, taken: ReadonlySet<string>): string {
  const stem = `fork-${base}`.slice(0, 64);
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = stem.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
