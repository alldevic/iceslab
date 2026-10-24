import type { TemplateType } from '@iceslab/shared';
import { checkTemplateBody, templateLanguage, TemplateInvalidError } from './templates.parse.js';

/**
 * A-236 step 8: a template file taken in as a draft. Nothing is saved: the
 * answer is a draft for the editor, which saves it after a dry run. The body
 * comes back byte for byte; it is checked like any body of its type
 * (checkTemplateBody), so the service key it may carry is ours, `iceslab`, in
 * the places our builders read it. A file written for another panel is made
 * ours before it comes here, by the migration tool (iceslab-migrate
 * templates), not by the panel (owner's decision 25.10, decisions.md).
 */

export interface ImportDraft {
  /** The body as it came. */
  body: string;
  /** The type asked for or recognised; null when the text does not say:
   *  a Clash-family YAML is the same text for mihomo, stash and clash, and an
   *  xray JSON for xray-json and xray-json-array. */
  type: TemplateType | null;
  /** Keys rewritten on the way in: none, the panel rewrites nothing. Kept in
   *  the answer for the screen that shows it. */
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
  const resolved = type ?? (json ? jsonType(body) : null);
  // Checked even without a type: the rules are one per language (the
  // Clash-family YAML, the JSON of sing-box and xray), so a broken file or a
  // service key we do not read is said now, not after the operator picks.
  checkTemplateBody(resolved ?? (json ? 'singbox' : 'mihomo'), body);
  return { body, type: resolved, rewrittenKeys: 0 };
}

/** sing-box names an outbound's kind `type`. An xray outbound names it
 *  `protocol`, and that is one shape for xray-json and xray-json-array alike,
 *  so it says nothing: null, the operator picks. */
function jsonType(body: string): TemplateType | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    // Said with its position by the check below.
    return null;
  }
  const outbounds = (v as { outbounds?: unknown } | null)?.outbounds;
  if (!Array.isArray(outbounds) || outbounds.length === 0) return null;
  const all = (k: string) => outbounds.every((o) => o !== null && typeof o === 'object' && k in o);
  return all('type') && !outbounds.some((o) => o && typeof o === 'object' && 'protocol' in o) ? 'singbox' : null;
}
