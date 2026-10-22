import type { FormValues } from '@/contours/users/lib/userForm';

/**
 * A refused save of the user drawer, read so it lands where it belongs (spec
 * frontend-users): a field the server names is marked on that field, the rest
 * is said at the form. It used to be a toast only, and the drawer threw from
 * its submit handler.
 *
 *   400 VALIDATION_ERROR { issues: [{ path, message }] }: per field;
 *   409 USERNAME_TAKEN { field: 'username' }, 409 SUBSCRIPTION_TOKEN_TAKEN
 *       { field: 'subscriptionToken' } (A-210, BACK e15eb494): at that field,
 *       in the panel's words when `say` is given (the server's are English);
 *   409 of any other code (CONFLICT from a server older than the split), 404
 *   NOT_FOUND (the user went away), any other 4xx with a sentence: at the
 *   form, in the server's words.
 * Null: nothing the server explained (network, 5xx), a toast says it.
 */
export interface UserSaveRefusal {
  fields: Partial<Record<keyof FormValues, string>>;
  message: string | null;
}

/** The two taken-value codes and the field each one belongs to. */
const TAKEN = {
  USERNAME_TAKEN: 'username',
  SUBSCRIPTION_TOKEN_TAKEN: 'subscriptionToken',
} as const satisfies Record<string, keyof FormValues>;

export type TakenCode = keyof typeof TAKEN;

/** API field -> the form field that edits it. */
const FIELD_OF: Record<string, keyof FormValues> = {
  username: 'username',
  subscriptionToken: 'subscriptionToken',
  trafficLimitGb: 'trafficLimitGb',
  trafficLimitStrategy: 'trafficLimitStrategy',
  expireDays: 'expireDays',
  expireAt: 'expireDays',
  status: 'status',
  description: 'description',
  tag: 'tag',
  email: 'email',
  telegramId: 'telegramId',
  hwidDeviceLimit: 'hwidDeviceLimit',
  groupIds: 'groupIds',
  routingPreset: 'routingPreset',
};

/**
 * Whether a refused save still needs the registry's toast (ARCH 23.10): not
 * when the drawer puts it at a field. One refusal, one place; the server's
 * English sentence beside the panel's words at the field was noise. Anything
 * not tied to a field (network, 5xx, a refusal at the form) keeps the toast.
 */
export function saveToastNeeded(err: unknown): boolean {
  // With a `say`, as the drawer reads it: a taken code without a sentence is
  // still put at its field by the panel's words.
  const refusal = userSaveRefusal(err, () => 'field');
  return !refusal || Object.keys(refusal.fields).length === 0;
}

export function userSaveRefusal(err: unknown, say?: (code: TakenCode) => string): UserSaveRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const res = (err as { response?: unknown }).response;
  if (!res || typeof res !== 'object') return null;
  const { status, data } = res as { status?: unknown; data?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500 || !data || typeof data !== 'object') return null;
  const d = data as { error?: unknown; message?: unknown; issues?: unknown };
  const message = typeof d.message === 'string' && d.message !== '' ? d.message : null;
  if (status === 409 && typeof d.error === 'string' && Object.hasOwn(TAKEN, d.error)) {
    const code = d.error as TakenCode;
    const text = say ? say(code) : message;
    // The field is the code's, whatever `field` says: a body naming another
    // one would put the words on a control that has nothing to fix.
    if (text) return { fields: { [TAKEN[code]]: text }, message: null };
  }
  if (d.error === 'VALIDATION_ERROR' && Array.isArray(d.issues)) {
    const fields: UserSaveRefusal['fields'] = {};
    const loose: string[] = [];
    for (const raw of d.issues) {
      if (!raw || typeof raw !== 'object') continue;
      const issue = raw as { path?: unknown; message?: unknown };
      const text = typeof issue.message === 'string' ? issue.message : '';
      const head = Array.isArray(issue.path) ? issue.path[0] : undefined;
      const field = typeof head === 'string' ? FIELD_OF[head] : undefined;
      if (field && !fields[field]) fields[field] = text;
      else if (text) loose.push(text);
    }
    return { fields, message: loose.length > 0 ? loose.join('; ') : Object.keys(fields).length > 0 ? null : message };
  }
  return message ? { fields: {}, message } : null;
}
