import { describe, expect, it } from 'vitest';
import { applyEntryUserGate } from './cascade.config.js';

/**
 * A-134: the entry's rules gated by who may take each tag. The live half (an
 * xray entry carrying these rules, clients choosing tags, counted at the
 * proxies) is cascade.entry-gate.live.test.ts.
 */
describe('applyEntryUserGate', () => {
  // Tags: plain direction 1 and 2 are 0 and 1; policy ordinal 1 adds 256.
  const rules = [
    { type: 'field', vlessRoute: '256,257', domain: ['domain:ads.example'], outboundTag: 'blocked' },
    { type: 'field', vlessRoute: '0,256', outboundTag: 'out-d1' },
    { type: 'field', vlessRoute: '1,257', outboundTag: 'out-d2' },
  ];

  it('splits a rule by who may take which tag, lists the users, and traps the gated tags last', () => {
    const gate = new Map<string, Set<number>>([
      ['u-nl', new Set([0])],
      ['u-all', new Set([0, 1, 256, 257])],
    ]);
    expect(applyEntryUserGate(rules, gate)).toEqual([
      { type: 'field', vlessRoute: '256,257', domain: ['domain:ads.example'], outboundTag: 'blocked', user: ['u-all'] },
      { type: 'field', vlessRoute: '0', outboundTag: 'out-d1' },
      { type: 'field', vlessRoute: '256', outboundTag: 'out-d1', user: ['u-all'] },
      { type: 'field', vlessRoute: '1,257', outboundTag: 'out-d2', user: ['u-all'] },
      { type: 'field', vlessRoute: '1,256,257', outboundTag: 'blocked' },
    ]);
  });

  it('a tag everybody may take is drawn as before, without a list or a trap', () => {
    const gate = new Map<string, Set<number>>([
      ['a', new Set([0, 1, 256, 257])],
      ['b', new Set([0, 1, 256, 257])],
    ]);
    expect(applyEntryUserGate(rules, gate)).toEqual(rules);
  });

  it('never draws an empty user list: a tag nobody may take loses its rule and goes to the trap', () => {
    const gate = new Map<string, Set<number>>([['a', new Set([0])]]);
    const out = applyEntryUserGate(rules, gate);
    expect(out.some((r) => Array.isArray(r.user) && (r.user as unknown[]).length === 0)).toBe(false);
    expect(out.find((r) => r.outboundTag === 'out-d2')).toBeUndefined();
    expect(out.at(-1)).toEqual({ type: 'field', vlessRoute: '1,256,257', outboundTag: 'blocked' });
  });

  it('an entry nobody reaches yet gates every tag, the trap closed by default', () => {
    const out = applyEntryUserGate(rules, new Map());
    expect(out).toEqual([{ type: 'field', vlessRoute: '0,1,256,257', outboundTag: 'blocked' }]);
  });
});
