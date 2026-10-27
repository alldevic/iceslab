import { describe, expect, it } from 'vitest';
import { effectiveDeviceCeiling, effectiveHwidLimit, resolveSquadHwidLimit } from './hwid.service.js';

// The device-row ceiling that bounds hwid_user_devices growth. `null` per-user
// limit (the common, unlimited case) must still fall under the system backstop
// so a client-controlled x-hwid header can't grow the table without bound.
describe('effectiveDeviceCeiling', () => {
  it('uses the system max when there is no per-user limit', () => {
    expect(effectiveDeviceCeiling(null, 1000)).toBe(1000);
  });

  it('uses the per-user limit when it is below the system max', () => {
    expect(effectiveDeviceCeiling(3, 1000)).toBe(3);
  });

  it('never exceeds the system max even if the per-user limit is higher', () => {
    expect(effectiveDeviceCeiling(5000, 1000)).toBe(1000);
  });
});

// K7 - the per-squad HWID device-limit merge rule (max = most-permissive).
describe('resolveSquadHwidLimit', () => {
  it('returns null when no squad sets a default', () => {
    expect(resolveSquadHwidLimit([null, null])).toBe(null);
    expect(resolveSquadHwidLimit([])).toBe(null);
  });

  it('uses the single squad default', () => {
    expect(resolveSquadHwidLimit([null, 3])).toBe(3);
  });

  it('takes the MAX (most-permissive cohort) across squads', () => {
    expect(resolveSquadHwidLimit([2, 5, null])).toBe(5);
    expect(resolveSquadHwidLimit([5, 2])).toBe(5);
  });

  it('ignores non-positive values', () => {
    expect(resolveSquadHwidLimit([0, -1, 4])).toBe(4);
    expect(resolveSquadHwidLimit([0, -1])).toBe(null);
  });
});
// A-148: the user's value in three meanings.
describe('effectiveHwidLimit', () => {
  it('null takes the squads', () => {
    expect(effectiveHwidLimit(null, [3, null])).toBe(3);
    expect(effectiveHwidLimit(null, [null])).toBe(null);
  });

  it('0 is an explicit no-limit over a squad limit', () => {
    expect(effectiveHwidLimit(0, [3])).toBe(null);
  });

  it('N wins over the squads, lower or higher', () => {
    expect(effectiveHwidLimit(2, [5])).toBe(2);
    expect(effectiveHwidLimit(7, [5])).toBe(7);
  });
});
