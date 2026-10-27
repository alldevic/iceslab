import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';

// The card's binding counter goes through i18next plurals, as the other
// counters do; it used to print «1 bindings» from a literal in NodeCard.tsx.
const i18n = i18next.createInstance();
await i18n.init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: 'en',
  interpolation: { escapeValue: false },
});

describe('карточка ноды: привязки во множественном числе', () => {
  it('en: 1 binding, 2 bindings', () => {
    expect(i18n.t('nodeCard.bindings', { lng: 'en', count: 1 })).toBe('1 binding');
    expect(i18n.t('nodeCard.bindings', { lng: 'en', count: 2 })).toBe('2 bindings');
  });
  it('ru: 1 привязка, 2 привязки, 5 привязок', () => {
    expect(i18n.t('nodeCard.bindings', { lng: 'ru', count: 1 })).toBe('1 привязка');
    expect(i18n.t('nodeCard.bindings', { lng: 'ru', count: 2 })).toBe('2 привязки');
    expect(i18n.t('nodeCard.bindings', { lng: 'ru', count: 5 })).toBe('5 привязок');
  });
});
