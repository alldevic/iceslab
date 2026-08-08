import { describe, expect, it } from 'vitest';
import { policiesForEntry, type RoutePolicyRef } from './cascade.service.js';

/**
 * A route policy belongs to the squad that granted it. These tests pin down
 * WHERE that grant is allowed to show up, which is the part that went wrong in
 * the field on 2026-08-08: a squad handing out the Dutch entry with "no ads"
 * granted also produced a "no ads" variant on a Swedish entry that belonged to
 * an entirely different squad. The operator never configured it, could not
 * switch it off, and the squad screen's own preview did not show it.
 */

const RU_ENTRY = 'node-ru-01';
const RU2_ENTRY = 'node-ru-02';
const NL_EXIT = 'node-nl-01';
const SE_EXIT = 'node-se-01';

const NO_ADS: RoutePolicyRef = { ordinal: 1, name: 'Без рекламы' };
const KIDS: RoutePolicyRef = { ordinal: 2, name: 'Детский' };

/** The field setup: two squads, each with its own entry, one of them granting
 *  a policy. Neither squad restricted its exits, which is why exit scoping
 *  alone could not tell them apart. */
const fieldSetup = () => ({
  groupIds: ['squad-no-ads', 'squad-test'],
  policiesByGroup: new Map([['squad-no-ads', [NO_ADS]]]),
  entryReach: new Map([
    [RU_ENTRY, new Set(['squad-no-ads'])],
    [RU2_ENTRY, new Set(['squad-test'])],
  ]),
});

describe('policiesForEntry', () => {
  it('keeps a grant on the entry its squad hands out', () => {
    const got = policiesForEntry({
      ...fieldSetup(),
      entryNodeId: RU_ENTRY,
      directionNodeIds: [NL_EXIT],
    });
    expect(got).toEqual([NO_ADS]);
  });

  it('does NOT leak a grant onto another squad’s entry', () => {
    const got = policiesForEntry({
      ...fieldSetup(),
      entryNodeId: RU2_ENTRY,
      directionNodeIds: [SE_EXIT],
    });
    expect(got).toEqual([]);
  });

  it('applies a grant on every entry the granting squad hands out', () => {
    const got = policiesForEntry({
      groupIds: ['squad-no-ads'],
      policiesByGroup: new Map([['squad-no-ads', [NO_ADS]]]),
      entryReach: new Map([
        [RU_ENTRY, new Set(['squad-no-ads'])],
        [RU2_ENTRY, new Set(['squad-no-ads'])],
      ]),
      entryNodeId: RU2_ENTRY,
      directionNodeIds: [SE_EXIT],
    });
    expect(got).toEqual([NO_ADS]);
  });

  // An entry nobody hands out cannot produce an endpoint at all, so reaching
  // this state means the caller's map and its bindings disagree. Granting
  // everything there would resurrect exactly the bug above.
  it('grants nothing on an entry missing from the reach map', () => {
    const got = policiesForEntry({
      ...fieldSetup(),
      entryNodeId: 'node-unknown',
      directionNodeIds: [SE_EXIT],
    });
    expect(got).toEqual([]);
  });

  // Callers that don't build the map (and the tests that predate it) must keep
  // the old behaviour rather than silently losing every policy.
  it('applies grants everywhere when no reach map is given', () => {
    const got = policiesForEntry({
      groupIds: ['squad-no-ads'],
      policiesByGroup: new Map([['squad-no-ads', [NO_ADS]]]),
      entryNodeId: RU2_ENTRY,
      directionNodeIds: [SE_EXIT],
    });
    expect(got).toEqual([NO_ADS]);
  });

  // The second gate, unchanged: a squad that named its exits speaks only on
  // those directions.
  it('still honours a squad’s exit allow-list', () => {
    const args = {
      groupIds: ['squad-no-ads'],
      policiesByGroup: new Map([['squad-no-ads', [NO_ADS]]]),
      entryReach: new Map([[RU_ENTRY, new Set(['squad-no-ads'])]]),
      entryNodeId: RU_ENTRY,
      exitAllowByGroup: new Map([['squad-no-ads', new Set([NL_EXIT])]]),
    };
    expect(policiesForEntry({ ...args, directionNodeIds: [NL_EXIT] })).toEqual([NO_ADS]);
    expect(policiesForEntry({ ...args, directionNodeIds: [SE_EXIT] })).toEqual([]);
  });

  it('unions grants from several squads that reach the same entry', () => {
    const got = policiesForEntry({
      groupIds: ['squad-a', 'squad-b'],
      policiesByGroup: new Map([
        ['squad-a', [NO_ADS]],
        ['squad-b', [KIDS]],
      ]),
      entryReach: new Map([[RU_ENTRY, new Set(['squad-a', 'squad-b'])]]),
      entryNodeId: RU_ENTRY,
      directionNodeIds: [NL_EXIT],
    });
    expect(got).toEqual([NO_ADS, KIDS]);
  });

  // The same policy granted by two squads is one variant, not two identical
  // lines in the client's list.
  it('deduplicates a policy granted by more than one squad', () => {
    const got = policiesForEntry({
      groupIds: ['squad-a', 'squad-b'],
      policiesByGroup: new Map([
        ['squad-a', [NO_ADS]],
        ['squad-b', [NO_ADS]],
      ]),
      entryReach: new Map([[RU_ENTRY, new Set(['squad-a', 'squad-b'])]]),
      entryNodeId: RU_ENTRY,
      directionNodeIds: [NL_EXIT],
    });
    expect(got).toEqual([NO_ADS]);
  });
});
