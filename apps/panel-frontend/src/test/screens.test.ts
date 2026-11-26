import { describe, expect, it } from 'vitest';
import { cyrillicIn, rawKeysIn, textProblems } from '@/test/screens';

describe('screen text checks', () => {
  it('finds Cyrillic, but not the language switch', () => {
    expect(cyrillicIn('Save Закрыть и выйти now')).toEqual(['Закрыть и выйти']);
    expect(cyrillicIn('Русский English')).toEqual([]);
  });

  it('finds a locale key shown as text, not a hostname or a version', () => {
    expect(rawKeysIn('see delivery.format.raw here')).toEqual(['delivery.format.raw']);
    expect(rawKeysIn('example.com 1.2.3 geosite:cn v0.3.1 xray.json')).toEqual([]);
  });

  it('lists a known exception only while it is still true', () => {
    const known = [{ name: 'p', cyrillic: ['Закрыть'], task: 't' }];
    expect(textProblems('p', 'Закрыть', known)).toEqual([]);
    expect(textProblems('p', 'Close', known)).toEqual(['stale exception (cyrillic) "Закрыть"']);
    expect(textProblems('q', 'Закрыть', known)).toEqual(['cyrillic in English UI: "Закрыть"']);
  });
});
