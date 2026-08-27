import { UA_MAX_LENGTH, compileUaPattern, uaPatternIsSafe } from '@iceslab/shared';

import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/logger.js';

// UA_MAX_LENGTH bounds the INPUT size and NOT regex backtracking: V8's engine
// backtracks, so a pathological pattern like `(a+)+` blows up on a crafted UA
// of thirty characters. The cap only keeps well-formed linear patterns cheap.
// What makes a pattern safe is `uaPatternIsSafe`, applied both at save time and
// — since 2026-08-28 — right here, see getCompiledRules.

/**
 * In-process cache of the enabled rules, precompiled to RegExp. `/sub` without
 * `?format` hits this on every client poll, so we avoid a DB round-trip AND a
 * RegExp recompile per request (matching the bindings / settings caches on the
 * same hot path). Busted on any rule mutation (invalidateSrrCache) and by a
 * short TTL as a backstop.
 */
const SRR_CACHE_TTL_MS = 60_000;
interface CompiledRule {
  re: RegExp;
  format: string;
}
let srrCache: { rules: CompiledRule[]; expiresAt: number } | null = null;

/** Clear the SRR rule cache. Call after any rule create / update / delete. */
export function invalidateSrrCache(): void {
  srrCache = null;
}

async function getCompiledRules(): Promise<CompiledRule[]> {
  if (srrCache && Date.now() < srrCache.expiresAt) return srrCache.rules;
  const raw = await prisma.subscriptionResponseRule.findMany({
    where: { enabled: true },
    orderBy: { priority: 'asc' },
    select: { uaPattern: true, format: true },
  });
  const rules: CompiledRule[] = [];
  for (const r of raw) {
    // Two reasons to skip, and the second one used to be nobody's job.
    //
    // The save-time guard in srr.schemas.ts refuses catastrophic patterns, and
    // its own comment says "Existing pre-fix rules are not re-validated". This
    // loop's comment pointed AT that guard for the guarantee. Between the two
    // sentences sat every rule stored before the guard existed: compiled here
    // and run against every `/sub` poll, which is the one path where a
    // backtracking pattern is a denial of service rather than a slow page.
    if (!uaPatternIsSafe(r.uaPattern)) {
      getLogger().warn(
        { uaPattern: r.uaPattern },
        '[srr] skipping a rule whose pattern is not safe to run (nested quantifier or does not compile)',
      );
      continue;
    }
    const re = compileUaPattern(r.uaPattern);
    if (re) rules.push({ re, format: r.format });
  }
  srrCache = { rules, expiresAt: Date.now() + SRR_CACHE_TTL_MS };
  return rules;
}

/**
 * Walk enabled SRR rules in `priority ASC` order; return the first rule's
 * `format` whose `uaPattern` regex matches the (truncated) User-Agent.
 *
 * Returns null when there's no UA, no rules, or no rule matches, the route
 * handler then falls through to its existing Accept-header heuristic and
 * finally to `plain`. The compiled RegExps carry no `g` flag, so `.test` is
 * stateless and safe to reuse from the cache.
 */
export async function matchFormatForUserAgent(
  userAgent: string | null | undefined,
): Promise<string | null> {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, UA_MAX_LENGTH);
  for (const rule of await getCompiledRules()) {
    if (rule.re.test(ua)) {
      return rule.format;
    }
  }
  return null;
}

/**
 * Compile a rule's pattern, throwing the way `new RegExp` throws.
 *
 * The inline-flag handling — operators paste patterns from grep/PCRE/Python, so
 * `(?i)foo` becomes a body plus flags — lives in `shared` now, because it was
 * written out three times: here, in the save-time schema, and in the browser
 * matcher, all three claiming in a comment to mirror one of the others.
 *
 * Kept as a named export because the seed-rule test compiles patterns with it.
 */
export function compileRule(pattern: string): RegExp {
  const re = compileUaPattern(pattern);
  if (!re) throw new SyntaxError(`invalid regular expression: ${pattern}`);
  return re;
}
