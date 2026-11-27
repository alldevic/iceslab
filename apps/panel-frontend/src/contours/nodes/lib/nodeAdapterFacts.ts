import type { Ipv6Mode, NodeCores, UserScopeGap } from '@iceslab/shared';
import { awgLabel } from '@/lib/domain/awg';
import { protocolLabelCompact } from '@/lib/domain/protocols';

type T = (key: string, vars?: Record<string, unknown>) => string;

/**
 * The slot named in words. For AmneziaWG the server puts the GENERATION in
 * `engine` ('1' | '3'), not an engine: «AmneziaWG 3.1», as the other screens
 * name it (awgLabel), never «amneziawg on 3». Any other slot is the protocol
 * on its engine.
 */
export function slotLabel(protocol: string, engine: string, t: T): string {
  if (protocol === 'amneziawg') {
    const generation = engine === '3' ? awgLabel(3) : engine === '1' ? awgLabel(1) : engine;
    return `${protocolLabelCompact(protocol)} ${generation}`;
  }
  // The engine by its own name («xray», «sing-box»): the core words of the
  // other screens («ядро xray») do not fit after «на».
  return t('nodeEdit.slotPair', { protocol: protocolLabelCompact(protocol), engine: engine === 'singbox' ? 'sing-box' : engine });
}

/** Every gap the contract names: a Record over the shared union, so a new
 *  member is a type error here rather than a gap silently skipped. */
const KNOWN_GAPS: Record<UserScopeGap, true> = { 'shared-secret': true, 'shared-users': true };

type Served = { profileName: string; port: number };

/**
 * A-195: profiles that share a single-inbound adapter on this node. The node
 * serves one of them (`served`), the rest do not work but are handed out in
 * the subscription. `null`: the server is older than the field, say nothing;
 * `[]`: none. The input is checked first; a malformed entry is skipped.
 */
export function slotConflictsOf(
  raw: unknown,
): { protocol: string; engine: string; served: Served | null; others: Served[] }[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: { protocol: string; engine: string; served: Served | null; others: Served[] }[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const { protocol, engine, bindings, servedBindingId } = c as {
      protocol?: unknown;
      engine?: unknown;
      bindings?: unknown;
      servedBindingId?: unknown;
    };
    // The slot is the pair (protocol, engine): shadowsocks on xray and on
    // sing-box are two adapters, so the engine is part of the fact.
    if (typeof protocol !== 'string' || typeof engine !== 'string' || !Array.isArray(bindings)) continue;
    const rows = bindings.filter(
      (b): b is { bindingId: string; profileName: string; port: number } =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as { bindingId?: unknown }).bindingId === 'string' &&
        typeof (b as { profileName?: unknown }).profileName === 'string' &&
        typeof (b as { port?: unknown }).port === 'number',
    );
    // Fewer than two well-formed bindings left is no conflict to name.
    if (rows.length < 2) continue;
    const served = rows.find((b) => b.bindingId === servedBindingId) ?? null;
    out.push({
      protocol,
      engine,
      served: served ? { profileName: served.profileName, port: served.port } : null,
      others: rows.filter((b) => b !== served).map((b) => ({ profileName: b.profileName, port: b.port })),
    });
  }
  return out;
}

/**
 * A-204: bindings on this node where a squad's limit on a user does not hold,
 * with why. `null`: the server is older than the field; `[]`: none. The input
 * is checked first; a gap the contract does not name is skipped.
 */
export function userScopeGapsOf(raw: unknown): { profileName: string; port: number; gap: UserScopeGap }[] | null {
  if (raw === undefined || !Array.isArray(raw)) return null;
  return raw.flatMap((g) => {
    if (!g || typeof g !== 'object') return [];
    const { profileName, port, gap } = g as { profileName?: unknown; port?: unknown; gap?: unknown };
    if (typeof profileName !== 'string' || typeof port !== 'number' || typeof gap !== 'string') return [];
    if (!Object.hasOwn(KNOWN_GAPS, gap)) return [];
    return [{ profileName, port, gap: gap as UserScopeGap }];
  });
}

/**
 * The node card's IPv6 line (18.2). `stack`: the agent can listen on `::` and
 * has a global address; `address`: a global address but no usable `::` socket;
 * `none`: the agent reported and has neither; `unknown`: the agent sends no
 * block (older than the field, or the node has not reported), which is NOT
 * `none` and is not drawn as a fault. The addresses ride along for the tooltip.
 */
export type NodeIpv6Fact = {
  state: 'stack' | 'address' | 'none' | 'unknown';
  count: number;
  addresses: string[];
  /** The host takes `::` but the agent's API is bound to 0.0.0.0 (installed
   *  before 18.4, NODE_HOST written into its env): the panel channel stays IPv4. */
  apiIpv4Only: boolean;
};

export function nodeIpv6Fact(cores: NodeCores | null | undefined): NodeIpv6Fact {
  const v = cores?.ipv6;
  if (!v || typeof v.stack !== 'boolean' || typeof v.global !== 'boolean') {
    return { state: 'unknown', count: 0, addresses: [], apiIpv4Only: false };
  }
  const addresses = Array.isArray(v.addresses) ? v.addresses.filter((a): a is string => typeof a === 'string') : [];
  const state = v.stack && v.global ? 'stack' : v.global ? 'address' : 'none';
  return { state, count: addresses.length, addresses, apiIpv4Only: v.stack && v.apiListen === '0.0.0.0' };
}

/**
 * The node card's IPv6 egress line (18.5): the agent's own outbound IPv6
 * connection check. `works` / `fails` as reported; `unknown`: the agent sends no
 * `egress` (older than the check), which is not `fails` and is not drawn as a
 * fault.
 */
export type NodeIpv6EgressFact = 'works' | 'fails' | 'unknown';

export function nodeIpv6EgressFact(cores: NodeCores | null | undefined): NodeIpv6EgressFact {
  const e = cores?.ipv6?.egress;
  return typeof e !== 'boolean' ? 'unknown' : e ? 'works' : 'fails';
}

/**
 * What the IPv6 switch of the node form says beside the facts (18.6). `on` with
 * no working egress is the operator's right and a warning, not a refusal: the
 * cores then resolve to AAAA and the exit to those addresses breaks. An agent
 * with no `ipv6` block does not take the mode at all (older than 18.2), so the
 * switch changes nothing there (said for `on` and `off`; `auto` is what every
 * agent does anyway). `auto` and `off` carry no other warning.
 */
export type NodeIpv6ModeNote = 'agentUnsupported' | 'onNotWorking' | null;

export function nodeIpv6ModeNote(cores: NodeCores | null | undefined, mode: Ipv6Mode): NodeIpv6ModeNote {
  if (mode === 'auto') return null;
  const fact = nodeIpv6Fact(cores);
  if (fact.state === 'unknown') return 'agentUnsupported';
  if (mode !== 'on') return null;
  return nodeIpv6EgressFact(cores) === 'fails' || fact.state === 'none' ? 'onNotWorking' : null;
}
