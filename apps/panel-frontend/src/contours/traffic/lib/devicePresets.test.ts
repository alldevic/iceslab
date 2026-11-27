import { describe, expect, it } from 'vitest';
import { blankPreset, presetWrite } from '@/contours/traffic/lib/devicePresets';

const dns = [{ match: ['geosite:category-ru'], server: 'tcp://77.88.8.8', note: '' }];
const rules = [{ match: ['geoip:ru'], action: 'direct' as const, note: '' }];
const stored = { id: '7f1c0000-0000-4000-8000-000000000001', name: 'Мой', builtIn: false, rules: [], dnsRules: [] };

describe('presetWrite (A-229)', () => {
  it('a new preset goes whole, under its typed name', () => {
    expect(presetWrite({ ...blankPreset(), name: 'из файла' }, '  Сплит ', rules, [])).toEqual({
      kind: 'create',
      input: { name: 'Сплит', rules, dnsRules: [] },
    });
  });

  it('an existing one sends only what changed; nothing changed is null', () => {
    expect(presetWrite(stored, 'Мой', [], [])).toBeNull();
    expect(presetWrite(stored, 'Новый', [], [])).toEqual({ kind: 'update', input: { name: 'Новый' } });
    expect(presetWrite(stored, 'Мой', rules, [])).toEqual({ kind: 'update', input: { rules } });
    // An emptied name is not a rename.
    expect(presetWrite(stored, '  ', [], [])).toBeNull();
  });

  it('a new preset sends dnsRules, empty ones too', () => {
    expect(presetWrite(blankPreset(), 'A', [], [], dns, [])).toEqual({ kind: 'create', input: { name: 'A', rules: [], dnsRules: dns } });
    expect(presetWrite(blankPreset(), 'A', [], [])).toEqual({ kind: 'create', input: { name: 'A', rules: [], dnsRules: [] } });
  });

  it('a rename alone does not send dnsRules; a change of them sends only them', () => {
    const own = { ...stored, dnsRules: dns };
    expect(presetWrite(own, 'Новый', [], [], dns, dns)).toEqual({ kind: 'update', input: { name: 'Новый' } });
    expect(presetWrite(own, 'Мой', [], [], dns, dns)).toBeNull();
    expect(presetWrite(own, 'Мой', [], [], [], dns)).toEqual({ kind: 'update', input: { dnsRules: [] } });
    expect(presetWrite(stored, 'Мой', [], [], dns, [])).toEqual({ kind: 'update', input: { dnsRules: dns } });
  });
});
