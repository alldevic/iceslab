import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { TemplateType } from '@iceslab/shared';

/**
 * A-236: a template body read and checked on write. YAML for the Clash family
 * (mihomo, stash, clash), JSON for sing-box and xray. What is checked here is
 * the text and our own service key `iceslab:`; whether the frame has a slot
 * the nodes can go into is the dry run's question (step 3).
 *
 * The service key, where it may stand and what it may say:
 *   - at the top of the frame: `iceslab: { routing: preset }`, the parts the
 *     routing preset in force decides (DNS, geo databases, rules). `preset` is
 *     the one value: it names the preset in force, not a preset of its own;
 *   - in a Clash-family proxy group: `include-proxies`, `select-random-proxy`,
 *     `shuffle-proxies-order` (booleans), how the panel fills that group;
 *   - in a Clash-family proxy provider: `include-proxies` (boolean), the nodes
 *     as the provider's payload.
 * Anything else inside `iceslab:` is refused with its line: a key the panel
 * would ignore is a frame that does not do what its author thinks.
 * For xray-json-array the body is one object, the frame of every element, and
 * `iceslab` sits on that object (templates.defaults.ts).
 */

export const SERVICE_KEY = 'iceslab';

export class TemplateInvalidError extends Error {
  readonly code = 'TEMPLATE_INVALID';
  constructor(
    message: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'TemplateInvalidError';
  }
}

export function templateLanguage(type: TemplateType): 'yaml' | 'json' {
  return type === 'mihomo' || type === 'stash' || type === 'clash' ? 'yaml' : 'json';
}

const GROUP_KEYS = ['include-proxies', 'select-random-proxy', 'shuffle-proxies-order'];
const PROVIDER_KEYS = ['include-proxies'];

/** The line of a JSON.parse error, out of the message V8 writes. */
function jsonErrorLine(body: string, message: string): { line?: number; column?: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) {
    const before = body.slice(0, Number(pos[1]));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
  }
  return {};
}

/**
 * Checks a body for its type. Answers nothing; refuses with
 * TemplateInvalidError (line and column where known).
 */
export function checkTemplateBody(type: TemplateType, body: string): void {
  if (body.trim() === '') throw new TemplateInvalidError('the template is empty');
  const json = templateLanguage(type) === 'json';
  if (json) {
    try {
      JSON.parse(body);
    } catch (err) {
      // V8 names the position for some errors and not for others ("Unexpected
      // token '}', ... is not valid JSON" has none); the YAML parser, which
      // reads JSON too, finds the line where V8 does not say it.
      let { line, column } = jsonErrorLine(body, String((err as Error).message));
      if (line === undefined) {
        const pos = parseDocument(body, { prettyErrors: true }).errors[0]?.linePos?.[0];
        line = pos?.line;
        column = pos?.col;
      }
      throw new TemplateInvalidError(`not valid JSON: ${String((err as Error).message).split('\n')[0]}`, line, column);
    }
  }
  // JSON is read a second time through the YAML parser for the positions of
  // what follows; JSON.parse above has already said it is strict JSON.
  const lines = new LineCounter();
  // prettyErrors gives each error its linePos; the message then carries a
  // code frame after its first line, which is cut below.
  const doc = parseDocument(body, { lineCounter: lines, uniqueKeys: true, prettyErrors: true });
  const at = (node: Node | null | undefined): { line?: number; col?: number } => {
    const offset = node?.range?.[0];
    return offset === undefined ? {} : lines.linePos(offset);
  };
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const pos = e.linePos?.[0];
    throw new TemplateInvalidError(`not valid YAML: ${e.message.split('\n')[0]}`, pos?.line, pos?.col);
  }
  const root = doc.contents;
  if (!isMap(root)) {
    throw new TemplateInvalidError(
      type === 'xray-json-array'
        ? 'the template is one config object, the frame of every element of the array'
        : 'the template is a config object at the top',
      at(root).line,
    );
  }

  checkServiceKey(root, ['routing'], at, (key, value) => {
    if (key === 'routing' && !(isScalar(value) && value.value === 'preset')) {
      return 'iceslab.routing takes one value, "preset" (the routing preset in force)';
    }
    return null;
  });

  if (json) return;
  const groups = root.get('proxy-groups', true);
  if (isSeq(groups)) {
    for (const g of groups.items) if (isMap(g)) checkServiceKey(g, GROUP_KEYS, at, booleanValue);
  }
  const providers = root.get('proxy-providers', true);
  if (isMap(providers)) {
    for (const p of providers.items) if (isMap(p.value)) checkServiceKey(p.value, PROVIDER_KEYS, at, booleanValue);
  }
}

function booleanValue(key: string, value: unknown): string | null {
  return isScalar(value) && typeof value.value === 'boolean' ? null : `iceslab.${key} is true or false`;
}

function checkServiceKey(
  owner: YAMLMap,
  allowed: string[],
  at: (n: Node | null | undefined) => { line?: number; col?: number },
  value: (key: string, v: unknown) => string | null,
): void {
  const pair = owner.items.find((p) => isScalar(p.key) && p.key.value === SERVICE_KEY);
  if (!pair) return;
  const map = pair.value;
  if (!isMap(map)) {
    throw new TemplateInvalidError(`${SERVICE_KEY}: takes keys (${allowed.join(', ')})`, at(pair.key as Node).line);
  }
  for (const p of map.items) {
    const key = isScalar(p.key) ? String(p.key.value) : '';
    const where = at(p.key as Node);
    if (!allowed.includes(key)) {
      throw new TemplateInvalidError(
        `${SERVICE_KEY}.${key} is not a key the panel reads here; known: ${allowed.join(', ')}`,
        where.line,
        where.col,
      );
    }
    const refusal = value(key, p.value);
    if (refusal) throw new TemplateInvalidError(refusal, at(p.value as Node).line ?? where.line, where.col);
  }
}
