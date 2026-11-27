import { parse as parseYaml } from 'yaml';
import type { TemplateType } from '@iceslab/shared';
import { DEFAULT_TEMPLATE_BODIES } from '../subscription-templates/templates.defaults.js';

/**
 * A-236 step 3: the frame a format builder fills, the operator template's body
 * read as data. The builders keep writing the nodes and the routing pieces as
 * before; the frame says what surrounds them. With the Default of each type
 * (templates.defaults.ts) the output is byte for byte what the builders wrote
 * before frames existed (golden: formats/__testdata__/templates-default.golden.json).
 *
 * The service key `iceslab` is read and removed here, so no client ever sees
 * it: `iceslab.routing: preset` asks for the panel's routing (the routing
 * preset in force with the operator's custom rules and domain lists, its DNS
 * and geo databases). A frame without it gets none of that: the operator who
 * writes their own rules is not handed ours on top.
 */

export type Frame = Record<string, unknown>;

/** A frame read once per body. Bodies are few and immutable as strings. */
const parsed = new Map<string, Frame>();

export function readFrame(type: TemplateType, body: string): Frame {
  const key = `${type}\u0000${body}`;
  let f = parsed.get(key);
  if (!f) {
    const yaml = type === 'mihomo' || type === 'stash' || type === 'clash';
    const value = (yaml ? parseYaml(body) : JSON.parse(body)) as unknown;
    f = value && typeof value === 'object' && !Array.isArray(value) ? (value as Frame) : {};
    if (parsed.size > 256) parsed.clear();
    parsed.set(key, f);
  }
  return f;
}

export function defaultFrame(type: TemplateType): Frame {
  return readFrame(type, DEFAULT_TEMPLATE_BODIES[type]);
}

/** A deep copy of the frame without the service key, whether it asked for
 *  the panel's routing, and whether it asked for the panel's DNS rules to be
 *  poured into its own `dns` (`iceslab: { dns: merge }`, 19.8). The cached frame
 *  is never written to. */
export function openFrame(frame: Frame): { cfg: Frame; routing: boolean; dnsMerge: boolean } {
  const cfg = structuredClone(frame);
  const service = cfg.iceslab as { routing?: unknown; dns?: unknown } | undefined;
  delete cfg.iceslab;
  return { cfg, routing: service?.routing === 'preset', dnsMerge: service?.dns === 'merge' };
}

/**
 * Whether a frame's own `dns` is in a shape the panel's DNS rules can be poured
 * into (19.8); in any other the frame wins whole, as without the mark:
 *   - xray: an object whose `servers`, if any, is a list;
 *   - mihomo: an object whose `nameserver-policy`, if any, is a map;
 *   - sing-box: an object of the 1.12+ form: `servers` a non-empty list of typed
 *     entries (the form before 1.12 names an `address` and has no `type`) and
 *     `rules`, if any, a list. A section with no servers is not touched: the
 *     panel's servers would become the first, the default for every other name.
 * Stash and the old Clash get no rules whatever the mark says.
 */
export function dnsMergeable(type: TemplateType, dns: unknown): boolean {
  if (!dns || typeof dns !== 'object' || Array.isArray(dns)) return false;
  const d = dns as Frame;
  switch (type) {
    case 'xray-json':
    case 'xray-json-array':
      return d.servers === undefined || Array.isArray(d.servers);
    case 'mihomo': {
      const p = d['nameserver-policy'];
      return p === undefined || (typeof p === 'object' && p !== null && !Array.isArray(p));
    }
    case 'singbox':
      return (
        Array.isArray(d.servers) &&
        d.servers.length > 0 &&
        d.servers.every((s) => typeof asObject(s).type === 'string' && asObject(s).address === undefined) &&
        (d.rules === undefined || Array.isArray(d.rules))
      );
    default:
      return false;
  }
}

/** Whether the frame's own `dns` is merged with the panel's rules: the mark is there and the shape allows it (19.8). */
export function frameMergesDns(type: TemplateType, frame: Frame): boolean {
  return frameHasOwnDns(frame) && asObject(frame.iceslab).dns === 'merge' && dnsMergeable(type, frame.dns);
}

/** Whether the frame has a `dns` of its own: the test the builders make (xray
 *  `frame.dns !== undefined`, Clash and sing-box `cfg.dns === undefined`), and
 *  the frame then wins whole, the panel's DNS rules do not reach it. */
export function frameHasOwnDns(frame: Frame): boolean {
  return frame.dns !== undefined;
}

/** Whether the frame asks for the hosts the operator hid (A-236 step 6):
 *  `iceslab: { includeHiddenHosts: true }` at its top. */
export function frameIncludesHidden(frame: Frame): boolean {
  return asObject(frame.iceslab).includeHiddenHosts === true;
}

/** `obj` with `key: value` placed right after `after` (or first when `after`
 *  is absent), the other keys in their order. Key order is output order. */
export function insertAfter(obj: Frame, after: string, key: string, value: unknown): Frame {
  const out: Frame = {};
  if (!(after in obj)) out[key] = value;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    out[k] = v;
    if (k === after) out[key] = value;
  }
  return out;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asObject(v: unknown): Frame {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Frame) : {};
}
