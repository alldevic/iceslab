import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_CASCADE_LINKS, countCascadeLinks } from '@iceslab/shared';

const step = (...ids: (string | null | '')[]) => ({ nodeIds: ids });

/**
 * One counter, and the vectors that separate it from the one the cascade forms
 * used to carry.
 *
 * It lives here rather than beside the source because nothing runs a test
 * inside `packages/shared` — the convention in this repository is that a shared
 * symbol is tested from a package that consumes it, the way
 * `panel-backend/src/lib/presence.test.ts` covers ONLINE_WINDOW_MS. The cascade
 * forms are the consumer that had this wrong.
 *
 * The old form arithmetic was `entries × (number of directions with a node)`.
 * Every case below where the two disagree is a shape an operator can build in
 * the editor today — pools on a step and transits alongside several directions
 * became ordinary saves in the v4 storage rewrite.
 */
describe('countCascadeLinks', () => {
  it('is zero when nothing leads anywhere', () => {
    expect(countCascadeLinks([step('a', 'b')], [step()])).toBe(0);
    expect(countCascadeLinks([], [])).toBe(0);
  });

  it('multiplies the entry pool by each direction pool', () => {
    // Old formula: 2 entries × 2 directions = 4. This: 2×1 + 2×2 = 6.
    expect(countCascadeLinks([step('a', 'b')], [step('x'), step('y', 'z')])).toBe(6);
  });

  it('counts a transit step, which the form arithmetic did not count at all', () => {
    // entry(2) → transit(3) → two directions of one.
    // Old formula: 2 × 2 = 4. This: 2×3 + 3×1 + 3×1 = 12.
    expect(countCascadeLinks([step('a', 'b'), step('t1', 't2', 't3')], [step('x'), step('y')])).toBe(
      12,
    );
  });

  it('is over the cap exactly where the API says it is', () => {
    // The shape from the comment: 8 entries, 8 transits, two directions of 8.
    // Old formula: 8 × 2 = 16, comfortably "fine". This: 64 + 64 + 64 = 192.
    const eight = (p: string) => step(...Array.from({ length: 8 }, (_, i) => `${p}${i}`));
    const total = countCascadeLinks([eight('e'), eight('t')], [eight('x'), eight('y')]);
    expect(total).toBe(192);
    expect(total).toBeGreaterThan(MAX_CASCADE_LINKS);
  });

  it('ignores the blank row a form draft carries', () => {
    // The picker the operator has not filled yet is an empty string in the
    // draft; counting it would make the number jump the moment a row appears.
    expect(countCascadeLinks([step('a', '', null)], [step('x', '')])).toBe(1);
  });

  it('caps at a number both halves can name', () => {
    expect(MAX_CASCADE_LINKS).toBe(64);
  });
});

describe('the cascade screens use it', () => {
  // Knowing the counter is right says nothing about who calls it. Both pages
  // had their own formula and the constant beside it said "Mirrors the backend
  // ceiling", which was true and beside the point.
  const PAGES = ['../pages/CascadeCreatePage.tsx', '../pages/CascadeEditPage.tsx'];

  it.each(PAGES)('%s counts links with the shared function', (page) => {
    const src = readFileSync(join(import.meta.dirname, page), 'utf8');
    expect(src, 'the page does not call the shared counter').toContain('countCascadeLinks(');
    // The formula it replaced, in the shape it had. A page that grows a second
    // one alongside the call is the state this is here to catch.
    expect(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, ''),
      'the old entries-times-directions arithmetic is back',
    ).not.toMatch(/Math\.max\(entryIds\.length, 1\) \* directions/);
  });

  it('and the editor takes the ceiling from the same place', () => {
    const src = readFileSync(join(import.meta.dirname, '../components/CascadeEditor.tsx'), 'utf8');
    expect(src).toContain('MAX_LINKS = MAX_CASCADE_LINKS');
  });
});
