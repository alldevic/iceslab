import { describe, expect, it } from 'vitest';
import {
  countryFlagEmoji,
  derivedAutoLineLabel,
  derivedDirectionLineLabel,
  normaliseLineLabel,
} from '@iceslab/shared';
import { cascadeAutoProfileLabel, cascadeProfileLabel, countryFlag } from './country-flag.js';

describe('line-label', () => {
  it('gives the backend helpers exactly the same strings (they delegate)', () => {
    const inputs: [string, string | null, string][] = [
      ['ru-entry', 'nl', 'nl-01'],
      ['ru-entry', 'NL', 'nl-01'],
      ['Кириллица', null, 'se-02'],
      ['x', 'zzz', 'y'],
      ['x', '', 'y'],
    ];
    for (const [n, cc, node] of inputs) {
      expect(cascadeProfileLabel(n, cc, node)).toBe(derivedDirectionLineLabel(n, cc, node));
    }
    expect(cascadeAutoProfileLabel('ru-entry')).toBe(derivedAutoLineLabel('ru-entry'));
    expect(countryFlag('se')).toBe(countryFlagEmoji('se'));
  });

  it('derives a direction line from the country, as the backend always did', () => {
    expect(derivedDirectionLineLabel('ru-entry', 'nl', 'nl-01')).toBe('🇳🇱 ru-entry → NL');
  });

  it('falls back to the exit name when there is no usable country', () => {
    expect(derivedDirectionLineLabel('ru-entry', null, 'nl-01')).toBe('ru-entry → nl-01');
    expect(derivedDirectionLineLabel('ru-entry', 'n', 'nl-01')).toBe('ru-entry → nl-01');
    expect(derivedDirectionLineLabel('ru-entry', undefined, 'x')).toBe('ru-entry → x');
  });

  it('derives the Auto line', () => {
    expect(derivedAutoLineLabel('ru-entry')).toBe('⚡ ru-entry → Auto');
  });

  it('builds flags from any two letters', () => {
    expect(countryFlagEmoji(' de ')).toBe('🇩🇪');
    expect(countryFlagEmoji('')).toBe('');
  });

  it('normalises an operator-typed name: trimmed, blank is not pinned', () => {
    expect(normaliseLineLabel('  Berlin  ')).toBe('Berlin');
    expect(normaliseLineLabel('   ')).toBeNull();
    expect(normaliseLineLabel('')).toBeNull();
    expect(normaliseLineLabel(null)).toBeNull();
    expect(normaliseLineLabel(undefined)).toBeNull();
  });
});
