import { describe, expect, it } from 'vitest';
import { ROUTING_PRESET_IDS } from '@iceslab/shared';
import {
  assignedPresetGone,
  presetChoiceName,
  presetChoiceOf,
  presetChoicePatch,
  presetChoiceRows,
} from '@/lib/domain/routingPresets';

const OWN = '7f1c0000-0000-4000-8000-000000000001';
const name = (id: string) => `built:${id}`;

describe('preset choice (A-229)', () => {
  it('one picker value for the pair: own id, built-in key or inherit', () => {
    expect(presetChoiceOf({ routingPreset: null, customRoutingPresetId: OWN })).toBe(OWN);
    expect(presetChoiceOf({ routingPreset: 'ru-split', customRoutingPresetId: null })).toBe('ru-split');
    expect(presetChoiceOf({ routingPreset: null })).toBe('');
    expect(presetChoiceOf(null)).toBe('');
  });

  it('a save sends the moved side only; inherit clears the side that was set', () => {
    expect(presetChoicePatch('ru-split', 'ru-split')).toEqual({});
    expect(presetChoicePatch('', 'cn-split')).toEqual({ routingPreset: 'cn-split' });
    expect(presetChoicePatch('ru-split', OWN)).toEqual({ customRoutingPresetId: OWN });
    expect(presetChoicePatch(OWN, 'proxy-all')).toEqual({ routingPreset: 'proxy-all' });
    expect(presetChoicePatch(OWN, '')).toEqual({ customRoutingPresetId: null });
    expect(presetChoicePatch('ru-split', '')).toEqual({ routingPreset: null });
  });

  it('never sends both keys with a value', () => {
    for (const seed of ['', 'ru-split', OWN]) {
      for (const value of ['', 'cn-split', OWN]) {
        const p = presetChoicePatch(seed, value);
        expect(p.routingPreset != null && p.customRoutingPresetId != null).toBe(false);
      }
    }
  });

  it('names a built-in in panel words and an own preset from the list; an unnamed own one is null, not its id', () => {
    const own = [{ id: OWN, name: 'Мой' }];
    expect(presetChoiceName('ru-split', undefined, name)).toBe('built:ru-split');
    expect(presetChoiceName(OWN, own, name)).toBe('Мой');
    expect(presetChoiceName(OWN, undefined, name)).toBeNull();
    expect(presetChoiceName('', own, name)).toBeNull();
  });

  it('rows: inherit, the shared built-ins, the own presets; a stored own one the list lacks keeps a row', () => {
    const words = { inherit: 'inherit', unnamed: 'unnamed', builtInName: name };
    const list = [
      { id: 'ru-split', name: 'ru-split', builtIn: true },
      { id: OWN, name: 'Мой', builtIn: false },
    ];
    const rows = presetChoiceRows('', list, words);
    expect(rows.map((r) => r.value)).toEqual(['', ...ROUTING_PRESET_IDS, OWN]);
    expect(presetChoiceRows(OWN, undefined, words).at(-1)).toEqual({ value: OWN, label: 'unnamed' });
  });

  it('reads 400 ROUTING_PRESET_NOT_FOUND only, input first', () => {
    const res = (status: number, data: unknown) => ({ response: { status, data } });
    expect(assignedPresetGone(res(400, { error: 'ROUTING_PRESET_NOT_FOUND', field: 'customRoutingPresetId' }))).toBe(true);
    expect(assignedPresetGone(res(404, { error: 'ROUTING_PRESET_NOT_FOUND' }))).toBe(false);
    expect(assignedPresetGone(res(400, { error: 'VALIDATION_ERROR' }))).toBe(false);
    expect(assignedPresetGone(null)).toBe(false);
  });
});
