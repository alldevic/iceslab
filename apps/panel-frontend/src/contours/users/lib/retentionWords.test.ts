import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { DELETED_USER_RETENTION_DAYS, HWID_DEVICE_RETENTION_DAYS } from '@iceslab/shared';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';
import { deleteRetentionText, deviceForgetText } from '@/contours/users/lib/retentionWords';

// Against the shared truth, not a copy of its value: the cron and the window
// read one constant.
const i18n = i18next.createInstance();
await i18n.init({ resources: { ru: { translation: ru }, en: { translation: en } }, lng: 'ru', interpolation: { escapeValue: false } });

describe('сроки хранения словами (A-268, A-269)', () => {
  it('окно удаления юзера называет срок из shared', () => {
    const calls: Record<string, unknown>[] = [];
    deleteRetentionText((_k, v) => (calls.push(v ?? {}), ''));
    expect(calls[0]).toEqual({ count: DELETED_USER_RETENTION_DAYS });
    expect(deleteRetentionText(i18n.t)).toContain(String(DELETED_USER_RETENTION_DAYS));
    expect(deleteRetentionText((k, v) => i18n.t(k, { ...v, lng: 'en' }))).toContain(String(DELETED_USER_RETENTION_DAYS));
  });
  it('список устройств называет срок из shared', () => {
    const calls: Record<string, unknown>[] = [];
    deviceForgetText((_k, v) => (calls.push(v ?? {}), ''));
    expect(calls[0]).toEqual({ count: HWID_DEVICE_RETENTION_DAYS });
    expect(deviceForgetText(i18n.t)).toContain(String(HWID_DEVICE_RETENTION_DAYS));
  });
  it('ru: плюрал дней верный на 1, 2, 5, 21', () => {
    const say = (n: number) => i18n.t('users.deleteRetention', { count: n });
    expect(say(1)).toContain('1 день');
    expect(say(2)).toContain('2 дня');
    expect(say(5)).toContain('5 дней');
    expect(say(21)).toContain('21 день');
  });
});
