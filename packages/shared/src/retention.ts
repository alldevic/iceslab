/**
 * How long the panel keeps what a user leaves behind, owner's decisions of
 * 26.10. One copy for the cron that erases (panel-backend
 * maintenance/retention.cron.ts) and for the screens that say it (the delete
 * dialog, the device list): a second copy of a number is how a screen comes to
 * promise a window the server does not keep.
 */

/** A-268: days a user deleted in the panel is kept, then erased with
 *  everything theirs (traffic, devices, keys, history). */
export const DELETED_USER_RETENTION_DAYS = 30;

/** A-269: days a device not seen is kept, then forgotten; it stops counting
 *  towards the user's device limit. */
export const HWID_DEVICE_RETENTION_DAYS = 90;
