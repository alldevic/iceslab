import { describe, expect, it } from 'vitest';
import { MOBILE_PRESET, TSPU_PRESET } from '@/contours/profiles/lib/awgPresets';
import { renameAwg } from '@/contours/profiles/lib/profileFormValues';
import { defaults } from '@/contours/profiles/lib/profileDefaults';
import {
  awgJunkProblem,
  awgKeyProblem,
  awgPaddingProblem,
  awgRuleProblems,
} from '@/contours/profiles/lib/awgRules';

const KEY = 'YAT+bEESM0kh2iD3ujUlW1SQ/HeGjigNdYRs8B5ZSEE=';
const keys = { awgServerPriv: KEY, awgServerPub: KEY };
const form = (over: Partial<ReturnType<typeof defaults>> = {}) => ({ ...defaults(null), ...keys, ...over });

describe('Jmin <= Jmax', () => {
  it('Jmin above Jmax is a problem, equal and below are not', () => {
    expect(awgJunkProblem(129, 128)).toBe(true);
    expect(awgJunkProblem(128, 128)).toBe(false);
    expect(awgJunkProblem(64, 128)).toBe(false);
  });

  it('an empty bound is read as the default the save sends', () => {
    expect(awgJunkProblem('', 63)).toBe(true);
    expect(awgJunkProblem(129, '')).toBe(true);
    expect(awgJunkProblem('', '')).toBe(false);
  });
});

describe('S1 + 56 != S2', () => {
  it('S2 equal to S1 + 56 is a problem', () => {
    expect(awgPaddingProblem(32, 88)).toBe(true);
    expect(awgPaddingProblem(32, 56)).toBe(false);
    expect(awgPaddingProblem(0, 56)).toBe(true);
  });

  it('empty reads as the defaults (32, 56)', () => {
    expect(awgPaddingProblem('', '')).toBe(false);
    expect(awgPaddingProblem('', 88)).toBe(true);
  });
});

describe('the server key shape', () => {
  it('44 base64 characters ending in = pass', () => {
    expect(awgKeyProblem(KEY)).toBe(false);
  });

  it.each(['', 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(44) + '=', '-_'.repeat(21) + 'A='])(
    'refuses %j',
    (k) => expect(awgKeyProblem(k)).toBe(true),
  );

  it('a missing key is a problem', () => {
    expect(awgKeyProblem(undefined)).toBe(true);
  });
});

describe('awgRuleProblems marks the field the operator has to change', () => {
  it('a new profile with both keys filled breaks nothing, on every preset', () => {
    expect([...awgRuleProblems(form())]).toEqual([]);
    for (const preset of [TSPU_PRESET, MOBILE_PRESET]) {
      expect([...awgRuleProblems(form(renameAwg(preset)))], JSON.stringify(preset)).toEqual([]);
    }
  });

  it('Jmin > Jmax marks Jmax, S1 + 56 = S2 marks S2, a bad key marks that key', () => {
    expect([...awgRuleProblems(form({ awgJmin: 200, awgJmax: 100 }))]).toEqual(['awgJmax']);
    expect([...awgRuleProblems(form({ awgS1: 10, awgS2: 66 }))]).toEqual(['awgS2']);
    expect([...awgRuleProblems(form({ awgServerPriv: 'x' }))]).toEqual(['awgServerPriv']);
    expect([...awgRuleProblems(form({ awgServerPub: '' }))]).toEqual(['awgServerPub']);
  });
});
