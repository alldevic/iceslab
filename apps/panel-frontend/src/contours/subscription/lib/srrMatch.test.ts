import { describe, expect, it } from 'vitest';
import type { SrrRule } from '@/lib/domain/srr';
import {
  compilePattern,
  isCatchAll,
  matchRule,
  matchingRules,
  patternCompiles,
  shadowedBy,
} from './srrMatch';

function rule(over: Partial<SrrRule> & Pick<SrrRule, 'id'>): SrrRule {
  return {
    name: over.id,
    uaPattern: '.*',
    format: 'plain',
    priority: 100,
    enabled: true,
    templateName: null,
    proto: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('compilePattern', () => {
  it('a plain pattern is case-sensitive', () => {
    const re = compilePattern('happ')!;
    expect(re.test('happ/1.0')).toBe(true);
    expect(re.test('HAPP/1.0')).toBe(false);
  });

  it('(?i) becomes the i flag and leaves the body', () => {
    const re = compilePattern('(?i)happ')!;
    expect(re.flags).toBe('i');
    expect(re.test('HAPP/1.0')).toBe(true);
  });

  it('keeps i, m, s and drops the flags ECMAScript has no use for', () => {
    expect(compilePattern('(?imsux)a')!.flags).toBe('ims');
    expect(compilePattern('(?ux)a')!.flags).toBe('');
  });

  it('a pattern that does not compile is null', () => {
    expect(compilePattern('(')).toBeNull();
    expect(compilePattern('(?i)[')).toBeNull();
  });

  it('flags in the middle are not an inline prefix', () => {
    expect(compilePattern('a(?i)b')).toBeNull();
  });
});

describe('patternCompiles', () => {
  it('the empty string does not count, a valid pattern does, a broken one does not', () => {
    expect(patternCompiles('')).toBe(false);
    expect(patternCompiles('(?i)clash')).toBe(true);
    expect(patternCompiles('[')).toBe(false);
  });
});

describe('matchingRules / matchRule', () => {
  it('walks rules by priority ascending, whatever order they come in', () => {
    const rules = [
      rule({ id: 'late', priority: 50, uaPattern: 'clash', format: 'clash' }),
      rule({ id: 'early', priority: 10, uaPattern: 'clash', format: 'singbox' }),
      rule({ id: 'any', priority: 99, uaPattern: '.*' }),
    ];
    expect(matchingRules(rules, 'clash/1').map((r) => r.id)).toEqual(['early', 'late', 'any']);
    expect(matchRule(rules, 'clash/1')).toMatchObject({ format: 'singbox' });
    expect(matchRule(rules, 'clash/1')!.rule.id).toBe('early');
  });

  it('does not reorder or mutate the caller list', () => {
    const rules = [rule({ id: 'b', priority: 2 }), rule({ id: 'a', priority: 1 })];
    matchingRules(rules, 'x');
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('skips disabled rules', () => {
    const rules = [
      rule({ id: 'off', priority: 1, enabled: false }),
      rule({ id: 'on', priority: 2 }),
    ];
    expect(matchRule(rules, 'x')!.rule.id).toBe('on');
  });

  it('skips a rule whose pattern does not compile, and the rest still match', () => {
    const rules = [
      rule({ id: 'broken', priority: 1, uaPattern: '(' }),
      rule({ id: 'ok', priority: 2, uaPattern: 'x' }),
    ];
    expect(matchingRules(rules, 'x').map((r) => r.id)).toEqual(['ok']);
  });

  it('(?i) rules match regardless of case', () => {
    const rules = [rule({ id: 'a', uaPattern: '(?i)^happ' })];
    expect(matchRule(rules, 'HAPP/2')).not.toBeNull();
  });

  it('cuts the User-Agent at 256 characters before matching', () => {
    const needle = [rule({ id: 'tail', uaPattern: 'needle' })];
    // fully inside the first 256: found; starting past the cut: not found
    expect(matchRule(needle, 'a'.repeat(250) + 'needle')).not.toBeNull();
    expect(matchRule(needle, 'a'.repeat(251) + 'needle')).toBeNull();
    // `$` sees the cut end, not the real one
    const end = (c: string) => [rule({ id: 'end', uaPattern: `${c}$` })];
    expect(matchRule(end('a'), 'a'.repeat(256) + 'b')).not.toBeNull();
    expect(matchRule(end('b'), 'a'.repeat(256) + 'b')).toBeNull();
  });

  it('no match gives null, and no rules gives null', () => {
    expect(matchRule([rule({ id: 'a', uaPattern: 'clash' })], 'curl')).toBeNull();
    expect(matchRule([], 'curl')).toBeNull();
  });

  it('the WireGuard kind (12.4) does not take part in matching', () => {
    const rules = [rule({ id: 'wg', format: 'wgconf', proto: 'amneziawg', uaPattern: 'wg' })];
    expect(matchRule(rules, 'wg-client')).toMatchObject({ format: 'wgconf' });
  });
});

describe('shadowedBy', () => {
  const rules = [
    rule({ id: 'first', priority: 10, uaPattern: 'happ' }),
    rule({ id: 'second', priority: 30, uaPattern: 'happ' }),
  ];
  const draft = { uaPattern: 'happ', priority: 20, enabled: true };

  it('an earlier rule that matches the sample shadows the draft', () => {
    expect(shadowedBy(rules, draft, 'happ/1')!.id).toBe('first');
  });

  it('the draft wins when it has the lowest priority', () => {
    expect(shadowedBy(rules, { ...draft, priority: 5 }, 'happ/1')).toBeNull();
  });

  it('a draft that does not match the sample is not shadowed', () => {
    expect(shadowedBy(rules, { ...draft, uaPattern: 'clash' }, 'happ/1')).toBeNull();
    expect(shadowedBy(rules, { ...draft, uaPattern: '(' }, 'happ/1')).toBeNull();
  });

  it('a disabled draft and an empty sample give null', () => {
    expect(shadowedBy(rules, { ...draft, enabled: false }, 'happ/1')).toBeNull();
    expect(shadowedBy(rules, draft, '')).toBeNull();
  });

  it('a disabled or non-matching existing rule does not shadow', () => {
    const others = [
      rule({ id: 'off', priority: 1, uaPattern: 'happ', enabled: false }),
      rule({ id: 'other', priority: 2, uaPattern: 'clash' }),
    ];
    expect(shadowedBy(others, draft, 'happ/1')).toBeNull();
  });

  it('excludeId keeps a rule from shadowing itself while it is edited', () => {
    expect(shadowedBy(rules, draft, 'happ/1', 'first')).toBeNull();
  });

  it('only rules strictly earlier shadow: equal priority does not', () => {
    expect(shadowedBy(rules, { ...draft, priority: 10 }, 'happ/1')).toBeNull();
  });
});

describe('isCatchAll', () => {
  it('.* and the unanchored empty alternative catch everything', () => {
    expect(isCatchAll('.*')).toBe(true);
    expect(isCatchAll('(?i).*')).toBe(true);
    expect(isCatchAll('a*')).toBe(true);
  });

  it('an empty field is a rule not yet written, not a catch-all', () => {
    expect(isCatchAll('')).toBe(false);
  });

  it('^$ matches only the empty string, a specific pattern matches neither', () => {
    expect(isCatchAll('^$')).toBe(false);
    expect(isCatchAll('happ')).toBe(false);
  });

  it('an uncompilable pattern is not a catch-all', () => {
    expect(isCatchAll('(')).toBe(false);
  });
});

/**
 * Known divergences from the server, recorded as what srrMatch does TODAY, not
 * as what it should do (decision of pass 5: pinned, not fixed).
 *
 * Since A-019 the backend compiles rules with `compileLinearRule` (V8 linear
 * engine, flag `l`): a backreference or a lookahead makes it throw, so the save
 * is refused (`srr.schemas.ts`) and a stored rule like that is not served. This
 * module builds a plain RegExp, so every row below compiles and matches here.
 * When srrMatch starts refusing them, these rows are the ones to flip.
 */
describe('divergences from the server linear engine', () => {
  const cases: Array<{ name: string; pattern: string; ua: string; matches: boolean }> = [
    { name: 'backreference', pattern: '(a)\\1', ua: 'xaax', matches: true },
    { name: 'positive lookahead', pattern: 'clash(?=/1)', ua: 'clash/1', matches: true },
    { name: 'negative lookahead', pattern: '^(?!curl)', ua: 'happ/1', matches: true },
    { name: 'lookahead after (?i)', pattern: '(?i)clash(?=/)', ua: 'CLASH/1', matches: true },
  ];

  it.each(cases)('$name: compiles here, the server refuses it', ({ pattern, ua, matches }) => {
    expect(compilePattern(pattern)).not.toBeNull();
    expect(patternCompiles(pattern)).toBe(true);
    expect(matchRule([rule({ id: 'r', uaPattern: pattern })], ua) !== null).toBe(matches);
  });

  it('a negative lookahead is even a catch-all here', () => {
    expect(isCatchAll('^(?!curl)')).toBe(true);
  });
});
