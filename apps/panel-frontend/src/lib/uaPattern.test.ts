import { describe, expect, it } from 'vitest';

import { hasNestedQuantifier, uaPatternIsSafe, compileUaPattern } from '@iceslab/shared';
import { compilePattern, patternCompiles, patternProblem } from './srrMatch';

/**
 * The pattern rules, and the side of them that had no guard.
 *
 * The API refuses a User-Agent pattern with a nested quantifier at save time,
 * and says why in its own comment: V8 backtracks, `(a+)+` is exponential on a
 * short crafted input, Node has no per-regex timeout, and the rule runs on the
 * public `/sub` path for every request.
 *
 * Every word of that is true of the browser. The rule editor compiled the
 * pattern the operator was still typing and ran it against a 256-character
 * sample on EVERY KEYSTROKE, with no check at all — so the tab froze before the
 * save that would have been refused. And the runtime path trusted the save-time
 * guard while that guard's own comment says rules stored before it are never
 * re-validated, which left a hole exactly the width of the fleet's history.
 *
 * Tested from here because this is the consumer that had it wrong; the shared
 * module has no runner of its own.
 */

/** Patterns V8 compiles happily and then chokes on. */
const DANGEROUS = ['(a+)+$', '(.*)*x', '(?i)(a+)+', '([a-z]+)*!', '(x{1,3}){2,4}y'];

/** Patterns an operator actually writes. */
const FINE = ['(?i)happ', 'v2rayNG/[0-9.]+', 'Clash|Stash|Shadowrocket', '^sing-box', 'a+b+c+'];

describe('uaPatternIsSafe', () => {
  it.each(DANGEROUS)('refuses %s', (p) => {
    // Each of these compiles. That is the point: "it compiled" was the only
    // question the browser side asked.
    expect(compileUaPattern(p), 'the fixture does not even compile').not.toBeNull();
    expect(hasNestedQuantifier(p.replace(/^\(\?[imsux]+\)/, ''))).toBe(true);
    expect(uaPatternIsSafe(p)).toBe(false);
  });

  it.each(FINE)('takes %s', (p) => {
    expect(uaPatternIsSafe(p)).toBe(true);
  });

  it('does not false-fire on an escaped or classed quantifier', () => {
    // `\+` and `[+]` are literal plus signs, not repetition.
    expect(uaPatternIsSafe('(a\\+)+')).toBe(true);
    expect(uaPatternIsSafe('([+])+')).toBe(true);
  });

  it('refuses a pattern that does not compile at all', () => {
    expect(uaPatternIsSafe('(unclosed')).toBe(false);
  });
});

describe('the browser matcher will not run one', () => {
  it.each(DANGEROUS)('%s does not come back as a usable RegExp', (p) => {
    // The whole defect in one line: this used to return a RegExp, and the rule
    // page then called `.test()` with it on every keystroke.
    expect(compilePattern(p)).toBeNull();
    expect(patternCompiles(p)).toBe(false);
  });

  it.each(FINE)('%s still does', (p) => {
    expect(compilePattern(p)).not.toBeNull();
  });
});

describe('and the form can say which of the two problems it is', () => {
  it('separates "does not compile" from "would run forever"', () => {
    // One is a typo, the other is a pattern that is perfectly well formed and
    // must not be used. Telling an operator "invalid regex" about `(a+)+` sends
    // them hunting for a syntax error that is not there.
    expect(patternProblem('(unclosed')).toBe('invalid');
    expect(patternProblem('(a+)+$')).toBe('redos');
    expect(patternProblem('(?i)happ')).toBeNull();
    expect(patternProblem('')).toBeNull();
  });
});
