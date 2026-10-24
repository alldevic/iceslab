import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { TemplateType } from '@iceslab/shared';
import { checkTemplateBody, SERVICE_KEY, templateLanguage, TemplateInvalidError } from './templates.parse.js';

/**
 * A-236 step 8: a template written for the panel operators move from, taken
 * in. Its insertion contract is ours already (docs/plan/subscription-
 * templates.md 4.1); what differs is the name of the service key. That key is
 * renamed to `iceslab` where our builders read one (the top of the frame, a
 * Clash-family proxy group, a proxy provider), in the TEXT, so the operator's
 * comments, anchors and layout come back as they wrote them. Nothing is saved:
 * the answer is a draft for the editor, which saves it after a dry run.
 *
 * What the renamed key says is then checked like any body of the type
 * (checkTemplateBody): a key of theirs we have no counterpart for is refused
 * with its line, never carried silently.
 */

/**
 * The source panel's service key. A format identifier on the wire, not a
 * mention: a foreign key cannot be recognised without spelling it (the
 * exception ARCH made for the migration tooling, 23.09). The one place the
 * literal lives on the server.
 */
export const SOURCE_SERVICE_KEY = 'remnawave';

export interface ImportDraft {
  /** The body with the key renamed; nothing else in it changed. */
  body: string;
  /** The type asked for or recognised; null when the text does not say
   *  (a Clash-family YAML is the same text for mihomo, stash and clash). */
  type: TemplateType | null;
  /** How many keys were renamed. */
  rewrittenKeys: number;
}

export function importTemplate(body: string, type?: TemplateType): ImportDraft {
  if (body.trim() === '') throw new TemplateInvalidError('the template is empty');
  const json = /^\s*[[{]/.test(body);
  if (type && (templateLanguage(type) === 'json') !== json) {
    throw new TemplateInvalidError(
      `a ${type} template is ${templateLanguage(type) === 'json' ? 'JSON' : 'YAML'}, and this file is ${json ? 'JSON' : 'YAML'}`,
    );
  }

  const lines = new LineCounter();
  const doc = parseDocument(body, { lineCounter: lines, prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const pos = e.linePos?.[0];
    throw new TemplateInvalidError(`not valid ${json ? 'JSON' : 'YAML'}: ${e.message.split('\n')[0]}`, pos?.line, pos?.col);
  }
  const root = doc.contents;
  if (!isMap(root)) throw new TemplateInvalidError('the template is a config object at the top');

  // The places our builders read a service key; the same list the write
  // check knows (templates.parse.ts).
  const owners: YAMLMap[] = [root];
  if (!json) {
    const groups = root.get('proxy-groups', true);
    if (isSeq(groups)) for (const g of groups.items) if (isMap(g)) owners.push(g);
    const providers = root.get('proxy-providers', true);
    if (isMap(providers)) for (const p of providers.items) if (isMap(p.value)) owners.push(p.value);
  }

  // Text ranges of the keys to rename, then a sweep for any left elsewhere.
  const renames: [number, number][] = [];
  for (const owner of owners) {
    for (const pair of owner.items) {
      if (isScalar(pair.key) && pair.key.value === SOURCE_SERVICE_KEY && pair.key.range) {
        renames.push([pair.key.range[0], pair.key.range[1]]);
      }
    }
  }
  const renamed = new Set(renames.map(([s]) => s));
  const stray = findKey(root, (n) => isScalar(n) && n.value === SOURCE_SERVICE_KEY && !renamed.has(n.range?.[0] ?? -1));
  if (stray) {
    const at = lines.linePos(stray.range?.[0] ?? 0);
    throw new TemplateInvalidError(
      "the source panel's service key stands here, where this panel reads none (only at the top, in a proxy group or in a proxy provider)",
      at.line,
      at.col,
    );
  }

  let out = body;
  for (const [start, end] of [...renames].sort((a, b) => b[0] - a[0])) {
    const quote = /^["']/.exec(out.slice(start, end))?.[0] ?? '';
    out = out.slice(0, start) + quote + SERVICE_KEY + quote + out.slice(end);
  }

  const resolved = type ?? (json ? jsonType(doc.toJS()) : null);
  if (resolved) checkTemplateBody(resolved, out);
  return { body: out, type: resolved, rewrittenKeys: renames.length };
}

/** sing-box names an outbound's kind `type`, xray `protocol`. */
function jsonType(v: unknown): TemplateType | null {
  const outbounds = (v as { outbounds?: unknown } | null)?.outbounds;
  if (!Array.isArray(outbounds)) return null;
  if (outbounds.some((o) => o && typeof o === 'object' && 'protocol' in o)) return 'xray-json-array';
  if (outbounds.some((o) => o && typeof o === 'object' && 'type' in o)) return 'singbox';
  return null;
}

/** The first map KEY anywhere under `node` that `match` accepts. */
function findKey(node: unknown, match: (n: Node) => boolean): Node | null {
  if (isMap(node)) {
    for (const p of node.items) {
      if (p.key && match(p.key as Node)) return p.key as Node;
      const inner = findKey(p.value, match);
      if (inner) return inner;
    }
  } else if (isSeq(node)) {
    for (const i of node.items) {
      const inner = findKey(i, match);
      if (inner) return inner;
    }
  }
  return null;
}
