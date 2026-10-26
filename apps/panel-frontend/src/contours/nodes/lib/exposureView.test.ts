import { describe, expect, it } from 'vitest';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';
import { EXPOSURE_KEYS, exposureView } from '@/contours/nodes/lib/exposureView';

const at = (d: unknown, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);

describe('проверка открытых портов (находка стенда 26.10)', () => {
  it('ключи, которые рисует блок, есть в обеих локалях строками', () => {
    for (const key of [...EXPOSURE_KEYS, 'nodeEdit.exposure', 'nodeEdit.exposureCheck']) {
      expect(typeof at(ru, key), `ru ${key}`).toBe('string');
      expect(typeof at(en, key), `en ${key}`).toBe('string');
    }
  });
  it('лишние порты читаются из extras, как отвечает сервер, а не из unexpectedPorts', () => {
    expect(exposureView({ checked: true, managed: true, expected: ['443/tcp'], extras: ['8080/tcp', '22/tcp'] })).toEqual({
      kind: 'extra',
      ports: ['8080/tcp', '22/tcp'],
    });
    expect(exposureView({ checked: true, extras: [] })).toEqual({ kind: 'clean' });
    // The old field name is not read: a list in it is not «clean» either.
    expect(exposureView({ checked: true, unexpectedPorts: [8080] })).toEqual({ kind: 'unknown' });
  });
  it('не проверено: с причиной сервера; мусор: не «чисто»', () => {
    expect(exposureView({ checked: false, note: 'ufw not installed on node' })).toEqual({ kind: 'skipped', note: 'ufw not installed on node' });
    expect(exposureView({ checked: false })).toEqual({ kind: 'skipped', note: null });
    for (const r of [null, 'x', {}, { checked: 'yes' }]) expect(exposureView(r)).toEqual({ kind: 'unknown' });
  });
});
