import { prisma } from '../../prisma.js';
import { getLogger } from '../../lib/infra/logger.js';
import { notifyTelegramAsync, escapeMarkdown } from '../../lib/notify/telegram-notify.js';
import { compileLinearRule, testLinearRule, type LinearRule } from './linear-regex.js';

/**
 * User-Agent length cap before regex evaluation. Since A-019 the rules run on
 * the linear engine (linear-regex.ts), so this bounds the work per rule to a
 * multiple of 256 characters; it is no longer the only thing between a
 * pattern and the event loop.
 */
const UA_MAX_LENGTH = 256;

/**
 * In-process cache of the enabled rules, precompiled to RegExp. `/sub` without
 * `?format` hits this on every client poll, so we avoid a DB round-trip AND a
 * RegExp recompile per request (matching the bindings / settings caches on the
 * same hot path). Busted on any rule mutation (invalidateSrrCache) and by a
 * short TTL as a backstop.
 */
const SRR_CACHE_TTL_MS = 60_000;
interface CompiledRule {
  re: LinearRule;
  format: string;
  name: string;
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
    // The name rides along for the admin side: "this user gets singbox" is an
    // assertion nobody can check, "rule Happ matched their User-Agent" is one
    // an operator can act on. The serving path ignores it.
    select: { name: true, uaPattern: true, format: true },
  });
  const rules: CompiledRule[] = [];
  for (const r of raw) {
    try {
      rules.push({ re: compileRule(r.uaPattern), format: r.format, name: r.name });
    } catch {
      // Bad regex, or one the linear engine cannot run (a rule stored before
      // A-019): not served. checkStoredRules names it at start.
    }
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
  return (await matchRuleForUserAgent(userAgent))?.format ?? null;
}

/**
 * The same walk, keeping the rule that won.
 *
 * The serving path only needs the format, but the admin side has to be able to
 * say WHY a user is getting one: a format on its own is an assertion an
 * operator cannot check, a rule name is something they can open and edit.
 */
export async function matchRuleForUserAgent(
  userAgent: string | null | undefined,
): Promise<{ name: string; format: string } | null> {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, UA_MAX_LENGTH);
  for (const rule of await getCompiledRules()) {
    if (testLinearRule(rule.re, ua)) {
      return { name: rule.name, format: rule.format };
    }
  }
  return null;
}

/**
 * A rule as a request runs it: the inline-flag prefix operators paste from
 * PCRE or Python (`(?i)foo`) turned into flags, on the linear engine. See
 * compileLinearRule.
 *
 * Exported for the client-catalog test, which runs every User-Agent sample
 * through the seeded rules exactly as a request would.
 */
export function compileRule(pattern: string): LinearRule {
  return compileLinearRule(pattern);
}

/**
 * A-019, at start: every stored rule is compiled as a request would compile
 * it. One the linear engine cannot run (a backreference or a lookahead, saved
 * before the engine moved) is not served from now on; it is named here, in the
 * log and to the operator, so it does not just stop matching in silence.
 */
export async function checkStoredRules(): Promise<{ name: string; error: string }[]> {
  const rows = await prisma.subscriptionResponseRule.findMany({
    where: { enabled: true },
    select: { name: true, uaPattern: true },
  });
  const refused: { name: string; error: string }[] = [];
  for (const r of rows) {
    try {
      compileRule(r.uaPattern);
    } catch (err) {
      refused.push({ name: r.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (refused.length > 0) {
    getLogger().warn({ refused }, '[srr] stored User-Agent rules that are not served');
    notifyTelegramAsync(
      `⚠️ *User-Agent rules not served*\n` +
        refused.map((r) => `\`${escapeMarkdown(r.name)}\`: ${escapeMarkdown(r.error)}`).join('\n') +
        `\nRewrite them without backreferences or lookaheads.`,
    );
  }
  return refused;
}
