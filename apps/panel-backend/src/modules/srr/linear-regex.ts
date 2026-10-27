import { setFlagsFromString } from 'node:v8';

/**
 * A-019: the User-Agent rules run on V8's linear-time regex engine.
 *
 * The rules are matched on the public `/sub` for every request, and V8's
 * default engine backtracks: `^(\w|\d)+$` against 30 digits and a `!` did not
 * finish in two minutes (measured 22.10), and Node has no per-regex timeout, so
 * one such rule held the whole panel. The save-time heuristic that stood guard
 * caught only a quantifier inside a quantified group and let alternation
 * through, the most common shape of the problem.
 *
 * The `l` flag (V8's experimental engine, `--enable-experimental-regexp-engine`)
 * runs in time linear in the input for any pattern it accepts, and refuses at
 * compile time what it cannot run that way: backreferences and lookaheads. So
 * the guarantee moves from a heuristic to the engine: a rule either compiles
 * linear or is not saved, and a stored one that does not is not served.
 *
 * Two limits of the engine, both handled here:
 *   - the flag needs the V8 option. The Dockerfile CMD passes it; this module
 *     also sets it from inside the process and checks that it took
 *     (assertLinearRegexEngine, at start), so a run without it fails loudly
 *     instead of silently going back to backtracking;
 *   - it does not take `i` together with `l` (V8 in Node 24). A case-blind rule,
 *     which every seeded one is (`(?i)happ`), is matched by folding instead:
 *     the pattern's literal letters lowercased, the User-Agent lowercased.
 */

const V8_FLAG = '--enable-experimental-regexp-engine';

function linearWorks(): boolean {
  try {
    new RegExp('a', 'l');
    return true;
  } catch {
    return false;
  }
}

/** Turn the engine on if the process started without it, and say whether it runs. */
export function enableLinearRegexEngine(): boolean {
  if (linearWorks()) return true;
  setFlagsFromString(V8_FLAG);
  return linearWorks();
}

/** The start-up self-check: no linear engine, no panel. */
export function assertLinearRegexEngine(): void {
  if (!enableLinearRegexEngine()) {
    throw new Error(
      `V8 linear regex engine unavailable: start node with ${V8_FLAG}. ` +
        'Without it a User-Agent rule could hold the panel on the public /sub.',
    );
  }
}

export interface LinearRule {
  re: RegExp;
  /** Match against the lowercased User-Agent: the rule was case-blind. */
  fold: boolean;
}

/**
 * Lowercases the literal letters of a pattern and leaves every escape as it
 * was: `\D`, `\W`, `\S`, `\B` mean something else in lower case, and so does
 * the name in `\p{Lu}`. A class range like `[A-Z]` becomes `[a-z]`, which is
 * what it has to be against a lowercased input.
 */
export function foldPatternCase(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c !== '\\') {
      out += c.toLowerCase();
      continue;
    }
    const next = pattern[i + 1];
    if (next === undefined) {
      out += c;
      continue;
    }
    out += c + next;
    i++;
    // \p{...}, \P{...}, \u{...}: the braces' content is a name or hex, as is.
    if ((next === 'p' || next === 'P' || next === 'u') && pattern[i + 1] === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end !== -1) {
        out += pattern.slice(i + 1, end + 1);
        i = end;
      }
    }
  }
  return out;
}

/**
 * A rule as the matcher runs it. The inline-flag prefix (`(?i)`, as operators
 * paste from PCRE or Python) becomes flags; `i` becomes folding, `m` and `s`
 * pass through, anything else is dropped as before. Throws a SyntaxError for a
 * pattern the linear engine cannot run.
 */
export function compileLinearRule(pattern: string): LinearRule {
  enableLinearRegexEngine();
  const m = pattern.match(/^\(\?([imsux]+)\)([\s\S]*)$/);
  const flags = m ? m[1]!.replace(/[^ims]/g, '') : '';
  const body = m ? m[2]! : pattern;
  const fold = flags.includes('i');
  const rest = flags.replace('i', '');
  return { re: new RegExp(fold ? foldPatternCase(body) : body, `${rest}l`), fold };
}

export function testLinearRule(rule: LinearRule, input: string): boolean {
  return rule.re.test(rule.fold ? input.toLowerCase() : input);
}
