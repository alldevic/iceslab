import { describe, expect, it } from 'vitest';
import { applyExitAcl } from './cascade.service.js';

// A4 increment 2: the pure squad exit-ACL filter (opt-in, index-preserving).
describe('applyExitAcl', () => {
  const full = [
    { name: 'nl', index: 0, nodeId: 'n-nl' },
    { name: 'se', index: 1, nodeId: 'n-se' },
    { name: 'de', index: 2, nodeId: 'n-de' },
  ];

  it('opt-in default: undefined allow-set keeps ALL exits', () => {
    expect(applyExitAcl(full, undefined)).toEqual([
      { name: 'nl', index: 0 },
      { name: 'se', index: 1 },
      { name: 'de', index: 2 },
    ]);
  });

  it('keeps only allowed exits, preserving their full-list index', () => {
    // Squad allows only "se" (link-out index 1) -> subset keeps index 1, NOT 0.
    expect(applyExitAcl(full, new Set(['n-se']))).toEqual([{ name: 'se', index: 1 }]);
  });

  it('a multi-node set (union across squads) keeps each with its own index', () => {
    expect(applyExitAcl(full, new Set(['n-nl', 'n-de']))).toEqual([
      { name: 'nl', index: 0 },
      { name: 'de', index: 2 },
    ]);
  });

  it('an allow-set matching no current exit yields none (entry falls back to auto)', () => {
    expect(applyExitAcl(full, new Set(['n-gone']))).toEqual([]);
  });
});
