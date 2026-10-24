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

/** A deep copy of the frame without the service key, and whether it asked for
 *  the panel's routing. The cached frame is never written to. */
export function openFrame(frame: Frame): { cfg: Frame; routing: boolean } {
  const cfg = structuredClone(frame);
  const service = cfg.iceslab as { routing?: unknown } | undefined;
  delete cfg.iceslab;
  return { cfg, routing: service?.routing === 'preset' };
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
