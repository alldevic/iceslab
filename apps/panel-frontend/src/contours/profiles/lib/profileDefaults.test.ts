import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_CONGESTION, LINK_CONGESTIONS } from '@iceslab/shared';
import { defaults } from '@/contours/profiles/lib/profileDefaults';
import { profileConfigOf } from '@/contours/profiles/lib/profileConfig';

/**
 * Дефолты формы профиля в той части, где они обещают поведение СЕРВЕРА.
 *
 * `tuicCongestion` до 22.09 стоял здесь словом `'bbr'`, а список значений был
 * переписан ещё в двух местах контура. Сервер сменит дефолт, форма неделю
 * продолжит предлагать прежнее, и ворота этого не увидят: формы проверяют, что
 * значение из союза, а не что союз тот же.
 */
describe('дефолты формы профиля', () => {
  it('1. congestion у tuic это дефолт контракта, а не своё слово', () => {
    expect(defaults(null).tuicCongestion).toBe(DEFAULT_LINK_CONGESTION);
    expect(LINK_CONGESTIONS).toContain(defaults(null).tuicCongestion);
  });

  it('2. новый профиль AmneziaWG с нетронутыми S3/S4 отправляет нули', () => {
    const form = { ...defaults(null), protocol: 'amneziawg' as const };
    const obf = profileConfigOf(form).obfuscation as Record<string, number>;
    expect(obf.s3).toBe(0);
    expect(obf.s4).toBe(0);
    // Поля очищены: запасное значение тоже 0, не 32/16.
    const cleared = profileConfigOf({ ...form, awgS3: '', awgS4: '' }).obfuscation as Record<string, number>;
    expect([cleared.s3, cleared.s4]).toEqual([0, 0]);
  });
});
