import { DELETED_USER_RETENTION_DAYS, HWID_DEVICE_RETENTION_DAYS } from '@iceslab/shared';

type T = (key: string, vars?: Record<string, unknown>) => string;

/**
 * How long the panel keeps what it no longer shows (A-268, A-269), with the
 * number the server's retention cron uses: both read it from shared, so the
 * window cannot promise 30 days while the cron erases after 14.
 */

/** A-268: a deleted user leaves the panel at once and is erased after N days. */
export function deleteRetentionText(t: T): string {
  return t('users.deleteRetention', { count: DELETED_USER_RETENTION_DAYS });
}

/** A-269: a device not seen for N days is forgotten and frees its slot. */
export function deviceForgetText(t: T): string {
  return t('userDrawer.devicesForget', { count: HWID_DEVICE_RETENTION_DAYS });
}
