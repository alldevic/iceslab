// The delivery matcher that runs in the browser.
//
// It decides which subscription FORMAT the panel tells an operator a given
// client will get, and it is a deliberate mirror of `srr.service.ts` on the
// backend - same order, same skip of disabled rules and uncompilable patterns,
// same inline-flag handling, same User-Agent truncation. The two are held
// together by nothing but that intention, so the rules are pinned here one by
// one; if the backend moves, this file is where the disagreement shows up.
//
// Getting it wrong is not a cosmetic bug. The operator writes a rule, the panel
// says "clients like this get sing-box", and the endpoint serves something else
// - so the rule looks correct and the subscriber's app silently receives a
// format it cannot read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SrrRule, SubscriptionFormat } from './api';
import { compilePattern, matchRule, matchingRules, patternCompiles, shadowedBy } from './srrMatch';
import { UA_MAX_LENGTH } from '@iceslab/shared';

let seq = 0;
function rule(over: Partial<SrrRule> = {}): SrrRule {
  seq += 1;
  return {
    id: `r${seq}`,
    name: `rule ${seq}`,
    uaPattern: 'happ',
    format: 'singbox' as SubscriptionFormat,
    priority: 100,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('compiling an operator-written pattern', () => {
  it('accepts an ordinary regex', () => {
    expect(compilePattern('happ')?.test('Happ/2.0')).toBe(false);
    expect(compilePattern('Happ')?.test('Happ/2.0')).toBe(true);
    expect(compilePattern('^v2ray(NG|N)')?.test('v2rayNG/1.9')).toBe(true);
  });

  // Operators paste patterns out of grep, PCRE and Python, where `(?i)` is how
  // you say case-insensitive. ECMAScript has no inline flags, so the prefix is
  // split off into real flags - and a pattern that kept the literal `(?i)` would
  // simply never match anything.
  it('understands the inline flags people paste from elsewhere', () => {
    expect(compilePattern('(?i)happ')?.test('HAPP/2.0')).toBe(true);
    expect(compilePattern('(?i)happ')?.flags).toContain('i');
    expect(compilePattern('(?im)^happ')?.test('x\nHAPP')).toBe(true);
    expect(compilePattern('(?s)a.b')?.test('a\nb')).toBe(true);
  });

  // `u` and `x` have no ECMAScript equivalent here and are dropped rather than
  // handed to the RegExp constructor, which would throw and take the rule with it.
  it('drops flags ECMAScript cannot take instead of failing the rule', () => {
    const re = compilePattern('(?ix)happ');
    expect(re, 'the rule must still compile').not.toBeNull();
    expect(re!.flags).toBe('i');
  });

  // A pattern that does not compile is skipped by the matcher, so it must be
  // reported as broken rather than silently swallowed.
  it('returns null for a pattern that is not a regex', () => {
    expect(compilePattern('(unclosed')).toBeNull();
    expect(compilePattern('a{2,1}')).toBeNull();
    expect(patternCompiles('(unclosed')).toBe(false);
    expect(patternCompiles(''), 'an empty pattern is not a rule').toBe(false);
    expect(patternCompiles('Happ')).toBe(true);
  });
});

describe('which rule wins', () => {
  it('walks rules by ascending priority, first match wins', () => {
    const rules = [
      rule({ id: 'late', uaPattern: 'Happ', priority: 300, format: 'clash' }),
      rule({ id: 'early', uaPattern: 'Happ', priority: 100, format: 'singbox' }),
      rule({ id: 'middle', uaPattern: 'Happ', priority: 200, format: 'xkeen' }),
    ];
    const hit = matchRule(rules, 'Happ/2.0');
    expect(hit?.rule.id).toBe('early');
    expect(hit?.format).toBe('singbox');
    // The rest are not "not matching" - they are shadowed, which is what the
    // create page shows the operator.
    expect(matchingRules(rules, 'Happ/2.0').map((r) => r.id)).toEqual(['early', 'middle', 'late']);
  });

  it('ignores disabled rules entirely', () => {
    const rules = [
      rule({ id: 'off', uaPattern: 'Happ', priority: 1, enabled: false, format: 'clash' }),
      rule({ id: 'on', uaPattern: 'Happ', priority: 2, format: 'singbox' }),
    ];
    expect(matchRule(rules, 'Happ/2.0')?.rule.id).toBe('on');
    expect(matchingRules(rules, 'Happ/2.0').map((r) => r.id)).toEqual(['on']);
  });

  // A rule whose pattern stopped compiling (an edit, an import) must not take
  // the whole match down with it; the next rule still gets its turn.
  it('skips a rule whose pattern does not compile', () => {
    const rules = [
      rule({ id: 'broken', uaPattern: '(unclosed', priority: 1, format: 'clash' }),
      rule({ id: 'good', uaPattern: 'Happ', priority: 2, format: 'singbox' }),
    ];
    expect(matchRule(rules, 'Happ/2.0')?.rule.id).toBe('good');
  });

  it('answers null when nothing matches, so the endpoint falls back to its default', () => {
    expect(matchRule([rule({ uaPattern: 'Happ' })], 'v2rayNG/1.9')).toBeNull();
    expect(matchRule([], 'anything')).toBeNull();
  });

  // The backend truncates the User-Agent at 256 characters before matching; a
  // pattern that only matches past that point matches there and not here, which
  // is precisely the disagreement this mirror exists to avoid.
  it('truncates the user agent at 256 characters, like the endpoint does', () => {
    const ua = `${'x'.repeat(300)}Happ`;
    expect(matchRule([rule({ uaPattern: 'Happ' })], ua)).toBeNull();

    const within = `${'x'.repeat(200)}Happ`;
    expect(matchRule([rule({ uaPattern: 'Happ' })], within)?.format).toBe('singbox');
  });

  // Measured: replacing the `[...rules]` copy with `rules` changes nothing,
  // because the `.filter()` in front of the sort already returns a new array.
  // The copy is belt-and-braces, and this test holds the property rather than
  // that particular line.
  it('does not reorder the caller’s array', () => {
    const rules = [
      rule({ id: 'b', priority: 200 }),
      rule({ id: 'a', priority: 100 }),
    ];
    matchingRules(rules, 'Happ/2.0');
    expect(rules.map((r) => r.id), 'sorting in place would shuffle the operator’s table').toEqual(['b', 'a']);
  });
});

describe('warning that a draft rule is already shadowed', () => {
  const existing = [
    rule({ id: 'existing', uaPattern: 'Happ', priority: 100, format: 'singbox' }),
  ];

  // The operator is about to save a rule that can never fire. Saying so before
  // the save is the whole feature.
  it('names the earlier rule that would win', () => {
    const hit = shadowedBy(existing, { uaPattern: 'Happ', priority: 200, enabled: true }, 'Happ/2.0');
    expect(hit?.id).toBe('existing');
  });

  it('stays quiet when the draft would win', () => {
    expect(
      shadowedBy(existing, { uaPattern: 'Happ', priority: 50, enabled: true }, 'Happ/2.0'),
    ).toBeNull();
  });

  // Equal priorities are not a shadow: the comparison is strictly earlier, and
  // claiming a shadow on a tie would warn about a rule that may well win.
  it('stays quiet on an equal priority', () => {
    expect(
      shadowedBy(existing, { uaPattern: 'Happ', priority: 100, enabled: true }, 'Happ/2.0'),
    ).toBeNull();
  });

  it('stays quiet when the draft does not match the sample at all', () => {
    expect(
      shadowedBy(existing, { uaPattern: 'v2rayNG', priority: 200, enabled: true }, 'Happ/2.0'),
    ).toBeNull();
  });

  it('stays quiet for a disabled draft or an empty sample', () => {
    expect(
      shadowedBy(existing, { uaPattern: 'Happ', priority: 200, enabled: false }, 'Happ/2.0'),
    ).toBeNull();
    expect(shadowedBy(existing, { uaPattern: 'Happ', priority: 200, enabled: true }, '')).toBeNull();
  });

  // Editing a rule must not warn that the rule shadows itself. The case that
  // actually distinguishes this is an edit that LOWERS the rule's precedence -
  // saved at 100, draft at 200 - because at an unchanged priority the strict
  // `<` comparison excludes the rule anyway and the exclusion is never asked
  // for. Measured: with the draft left at 100 this test passed even with
  // `excludeId` ignored entirely.
  it('does not let a rule shadow itself while being edited', () => {
    expect(
      shadowedBy(
        existing,
        { uaPattern: 'Happ', priority: 200, enabled: true },
        'Happ/2.0',
        'existing',
      ),
      'lowering a saved rule’s precedence would otherwise report the rule as its own shadow',
    ).toBeNull();
    // Control: without the exclusion, that very rule IS the shadow.
    expect(
      shadowedBy(existing, { uaPattern: 'Happ', priority: 200, enabled: true }, 'Happ/2.0')?.id,
    ).toBe('existing');
  });

  it('reports the earliest shadow when several exist', () => {
    const many = [
      rule({ id: 'first', uaPattern: 'Happ', priority: 10 }),
      rule({ id: 'second', uaPattern: 'Happ', priority: 20 }),
    ];
    expect(
      shadowedBy(many, { uaPattern: 'Happ', priority: 999, enabled: true }, 'Happ/2.0')?.id,
    ).toBe('first');
  });
});

/**
 * The two halves of the delivery matcher, compared where they are declared.
 *
 * `srrMatch.ts` says of itself that it is "a deliberate mirror of
 * srr.service.ts on the backend: same order, same skip of disabled rules and of
 * patterns that do not compile, same inline-flag handling, same User-Agent
 * truncation". The cases above prove the matching; this proves the one constant
 * both files declare separately, and the drift it would cause is quiet: a
 * browser that truncated the UA at a different length names a different rule
 * than the server applies, so the operator's test answers one thing and the
 * client gets another.
 */
describe('the truncation the two matchers share', () => {
  const HERE = import.meta.dirname;
  const FRONT = readFileSync(join(HERE, 'srrMatch.ts'), 'utf8');
  const BACK = readFileSync(
    join(HERE, '..', '..', '..', 'panel-backend', 'src', 'modules', 'srr', 'srr.service.ts'),
    'utf8',
  );

  it('is the same length on both sides, because it is the same constant', () => {
    // This case used to read `const UA_MAX_LENGTH = 256;` out of each file, and
    // that is how it caught the change below: neither file declares it any
    // more. Three copies of the pattern rules — the cap, the inline-flag split
    // and the ReDoS heuristic — moved to `shared` on 2026-08-28, after the
    // browser half turned out to have the first two and not the third, and to
    // be running operator-typed patterns on every keystroke without it.
    expect(UA_MAX_LENGTH).toBe(256);
    for (const [src, where] of [
      [FRONT, 'srrMatch.ts'],
      [BACK, 'srr.service.ts'],
    ] as const) {
      expect(src, `${where} declares its own UA cap again`).not.toMatch(
        /const UA_MAX_LENGTH = \d+;/,
      );
      expect(src, `${where} does not take the cap from shared`).toContain('UA_MAX_LENGTH');
      expect(src).toContain("from '@iceslab/shared'");
    }
  });

  it('and neither side carries its own copy of the inline-flag split', () => {
    // The regex that separates `(?i)` from the body. It was written out three
    // times, and each copy's comment said it mirrored one of the others.
    for (const [src, where] of [
      [FRONT, 'srrMatch.ts'],
      [BACK, 'srr.service.ts'],
    ] as const) {
      expect(src, `${where} still splits inline flags itself`).not.toMatch(
        /\(\\\?\(\[imsux\]\+\)\\\)/,
      );
    }
  });
});
