import { UA_MAX_LENGTH, compileUaPattern, uaPatternIsSafe } from '@iceslab/shared';

import type { SrrRule, SubscriptionFormat } from './api';

/**
 * The delivery matcher, run in the browser.
 *
 * This is a deliberate mirror of `srr.service.ts` on the backend: same order
 * (priority ascending), same skip of disabled rules and of patterns that do not
 * compile, same inline-flag handling, same User-Agent truncation. Both run on
 * V8, so the two agree.
 *
 * The panel needs it because `POST /api/srr/test` answers with the FORMAT only,
 * and the question an operator is actually asking is "which rule caught this",
 * which the endpoint cannot say. Matching here names the rule and lets the
 * create page answer the same question about a rule that does not exist yet.
 */

/**
 * Compile a pattern for use HERE, in the operator's browser — or refuse.
 *
 * Refusing is the part that was missing. The API rejects a pattern with a
 * nested quantifier at save time, because V8 backtracks and `(a+)+` is
 * exponential on a short crafted input; its comment says the UA-length cap does
 * not defang that. All of it is equally true of this side, which ran the
 * pattern the operator was still typing against a 256-character sample on every
 * keystroke, with no guard: the tab froze before the save that would have been
 * refused.
 *
 * Both questions now come from `shared`, so the rule is one rule. And the check
 * is applied to STORED rules too, not just to the one being edited: patterns
 * saved before the API check existed were never re-validated, so the database
 * is not a source of safe patterns.
 */
export function compilePattern(pattern: string): RegExp | null {
  if (!uaPatternIsSafe(pattern)) return null;
  return compileUaPattern(pattern);
}

/** Does this pattern compile at all? The save would be refused otherwise. */
export function patternCompiles(pattern: string): boolean {
  return pattern.length > 0 && compilePattern(pattern) !== null;
}

/**
 * Why a pattern was refused, for a form that has to say something better than
 * "invalid": the two reasons need different fixes.
 */
export function patternProblem(pattern: string): 'invalid' | 'redos' | null {
  if (pattern.length === 0) return null;
  if (compileUaPattern(pattern) === null) return 'invalid';
  if (!uaPatternIsSafe(pattern)) return 'redos';
  return null;
}

export interface MatchResult {
  rule: SrrRule;
  format: SubscriptionFormat;
}

/** Every enabled rule matching this UA, in the order the endpoint walks them.
 *  The first is the winner; the rest are shadowed by it. */
export function matchingRules(rules: SrrRule[], userAgent: string): SrrRule[] {
  const ua = userAgent.slice(0, UA_MAX_LENGTH);
  return [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)
    .filter((r) => {
      const re = compilePattern(r.uaPattern);
      return re !== null && re.test(ua);
    });
}

/** The rule the subscription endpoint would serve for this UA, or null when
 *  nothing matches and it falls back to its own default. */
export function matchRule(rules: SrrRule[], userAgent: string): MatchResult | null {
  const hit = matchingRules(rules, userAgent)[0];
  return hit ? { rule: hit, format: hit.format } : null;
}

/**
 * Which existing rule would beat a draft rule on this User-Agent. Returns null
 * when the draft wins, when it does not match the sample at all, or when there
 * is nothing to compare against.
 *
 * `excludeId` keeps a rule from shadowing itself while being edited.
 */
export function shadowedBy(
  rules: SrrRule[],
  draft: { uaPattern: string; priority: number; enabled: boolean },
  userAgent: string,
  excludeId?: string,
): SrrRule | null {
  if (!draft.enabled || !userAgent) return null;
  const re = compilePattern(draft.uaPattern);
  if (!re || !re.test(userAgent.slice(0, UA_MAX_LENGTH))) return null;
  const earlier = matchingRules(
    rules.filter((r) => r.id !== excludeId),
    userAgent,
  ).filter((r) => r.priority < draft.priority);
  return earlier[0] ?? null;
}
