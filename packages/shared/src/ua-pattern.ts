/**
 * What a User-Agent rule's pattern is allowed to be, on both sides.
 *
 * The panel matches rules in the browser as well as on the server — the same
 * order, the same inline-flag handling, the same UA truncation, because the
 * question an operator asks ("which rule caught this UA") is one the API cannot
 * answer, it returns the format only. So the pattern an operator types runs in
 * V8 twice: once in their own tab, on every keystroke, and once on the public
 * `/sub` path for every request.
 *
 * The ReDoS heuristic used to live on the API side alone. Its comment there
 * explains why it exists — V8 backtracks, `(a+)+` is exponential on a short
 * crafted input, and Node has no per-regex timeout, so capping the UA length
 * does not defang it — and every word of that is true of the browser as well.
 * The form ran the untyped pattern against a 256-character sample as the
 * operator typed it, with no guard at all: the tab froze before the save it
 * would have been refused by.
 *
 * One implementation now, in `shared`, called by the schema and by the form.
 */

/** The longest User-Agent either side will match against. */
export const UA_MAX_LENGTH = 256;

/**
 * ECMAScript has no inline flag syntax, but operators paste patterns from
 * grep / PCRE / Python, so `(?i)foo` is split into flags plus body. Unsupported
 * flags are dropped rather than refused.
 */
export function splitInlineFlags(pattern: string): { body: string; flags: string } {
  const m = pattern.match(/^\(\?([imsux]+)\)([\s\S]*)$/);
  return m ? { body: m[2]!, flags: m[1]!.replace(/[^ims]/g, '') } : { body: pattern, flags: '' };
}

/** Compiles, or null. Both sides skip a rule whose pattern does not. */
export function compileUaPattern(pattern: string): RegExp | null {
  const { body, flags } = splitInlineFlags(pattern);
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * Best-effort ReDoS heuristic: a quantified group whose body is itself
 * quantified.
 *
 * A full detector needs a parser. This collapses innermost groups and flags the
 * nesting, counting bounded `{n,m}` too, because nested repetition is slow even
 * where it is not strictly exponential. Escaped characters and character
 * classes are neutralised first so `\+` and `[+]` do not false-fire.
 *
 * Rules saved before this check existed are not re-validated, which is why the
 * BROWSER side skips them at match time rather than trusting the database.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  let s = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'C');
  const QUANT = /[*+]|\{\d*,\d*\}/;
  const INNER = /\(([^()]*)\)([*+]|\{\d*,\d*\})?/;
  for (let i = 0; i < 200; i++) {
    const m = s.match(INNER);
    if (!m) break;
    const bodyHasQuant = QUANT.test(m[1]!);
    if (m[2] && bodyHasQuant) return true;
    s = s.replace(INNER, bodyHasQuant || m[2] ? '+' : 'x');
  }
  return false;
}

/**
 * The one question both sides ask before letting a pattern near V8: is it safe
 * to run? Compiling is not enough — `(a+)+$` compiles fine.
 */
export function uaPatternIsSafe(pattern: string): boolean {
  if (compileUaPattern(pattern) === null) return false;
  return !hasNestedQuantifier(splitInlineFlags(pattern).body);
}
