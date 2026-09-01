import { describe, expect, it } from 'vitest';
import { hasNestedQuantifier, SrrFormat } from './srr.schemas.js';
import { SUBSCRIPTION_FORMATS } from '../subscription/subscription.format-names.js';

describe('hasNestedQuantifier (ReDoS heuristic)', () => {
  it('flags nested quantifiers as unsafe', () => {
    const dangerous = [
      '(a+)+',
      '(.*)*',
      '(\\w+)+',
      '(a+|b)*',
      '((a+))+',
      '(?:a+)+',
      'x(a*)+y',
      '(a{2,}){3,}',
    ];
    for (const p of dangerous) {
      expect(hasNestedQuantifier(p), p).toBe(true);
    }
  });

  it('allows linear / non-nested patterns', () => {
    const safe = [
      'iPhone',
      '(iPhone|iPad|iPod)',
      '(a|b)*',
      'Mozilla.*Safari',
      '(v2ray)+',
      'abc{2,4}',
      '[a+]+', // + is a literal inside the char class
      '\\(a+\\)+', // escaped parens: no real group
      'Happ/([0-9.]+)',
    ];
    for (const p of safe) {
      expect(hasNestedQuantifier(p), p).toBe(false);
    }
  });
});

// The rule's format list is a THIRD copy of the format vocabulary, after the
// route's query enum and the host gate's - and it drifted exactly the way the
// header of subscription.format-names.ts describes the other two drifting.
// `xrayjson-array` was renderable and reachable only by a `?format=` nobody
// sends, so the format built FOR Happ could not be given to Happ.
//
// Both directions are asserted. A format the route cannot render is a rule that
// silently serves something else; a whole-subscription format the route renders
// but no rule can name is a client that cannot be sent to it.
describe('the User-Agent rule format vocabulary', () => {
  // Per-node artefacts, not whole-subscription renderings: no UA resolves here.
  const NOT_UA_SELECTABLE = ['amneziavpn'];

  it('names only formats the subscription route can render', () => {
    for (const f of SrrFormat.options) {
      expect(SUBSCRIPTION_FORMATS, `rule format ${f}`).toContain(f);
    }
  });

  it('can name every whole-subscription format the route renders', () => {
    for (const f of SUBSCRIPTION_FORMATS) {
      if (NOT_UA_SELECTABLE.includes(f)) continue;
      expect(SrrFormat.options as readonly string[], `no rule can select ${f}`).toContain(f);
    }
  });
});
