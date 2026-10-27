import { describe, expect, it } from 'vitest';
import { UpdateSrrSchema, ruleProblem } from './srr.schemas.js';
import { compileLinearRule, foldPatternCase, testLinearRule } from './linear-regex.js';

/**
 * A-019: a User-Agent rule runs on V8's linear engine, so its time is linear in
 * the User-Agent whatever its shape, and the save refuses only what that engine
 * cannot run.
 */
describe('saving a rule', () => {
  it('takes the shapes the old heuristic missed or refused, and they stay linear', () => {
    // Missed by the heuristic: ran for minutes on the backtracking engine.
    for (const p of ['^(\\w|\\d)+$', '(a|aa)+$', '(\\d|[0-9])*x', '(a+)+', '(.*)*']) {
      expect(ruleProblem(p), p).toBeNull();
    }
    // Refused by the heuristic, harmless and useful.
    expect(ruleProblem('Happ/(\\d+\\.)+')).toBeNull();
  });

  it('refuses a backreference and a lookahead in words, and a broken pattern as broken', () => {
    expect(ruleProblem('(a)\\1')).toMatch(/backreference or a lookahead/);
    expect(ruleProblem('(?=happ)')).toMatch(/backreference or a lookahead/);
    expect(ruleProblem('[invalid(')).toBe('Invalid regex pattern');
    expect(UpdateSrrSchema.safeParse({ uaPattern: '(?!x)y' }).success).toBe(false);
    expect(UpdateSrrSchema.safeParse({ uaPattern: '^(\\w|\\d)+$' }).success).toBe(true);
  });
});

describe('matching on the linear engine', () => {
  it('answers the audit input at once', () => {
    const rule = compileLinearRule('^(\\w|\\d)+$');
    const t = performance.now();
    expect(testLinearRule(rule, '1'.repeat(30) + '!')).toBe(false);
    expect(testLinearRule(rule, '1'.repeat(256) + '!')).toBe(false);
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('keeps (?i) case-blind by folding, and leaves escapes alone', () => {
    const r = compileLinearRule('(?i)^Happ/\\d+');
    expect(testLinearRule(r, 'happ/3')).toBe(true);
    expect(testLinearRule(r, 'HAPP/3')).toBe(true);
    expect(testLinearRule(r, 'happ/x')).toBe(false);
    // \D stays "not a digit", \p{Lu} keeps its name.
    expect(foldPatternCase('A\\D[B-Z]\\p{Lu}')).toBe('a\\D[b-z]\\p{Lu}');
    const plain = compileLinearRule('Happ');
    expect(testLinearRule(plain, 'happ')).toBe(false);
  });
});
