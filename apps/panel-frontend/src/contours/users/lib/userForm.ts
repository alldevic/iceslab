import type { TrafficLimitStrategy, UpdateUserInput, User } from '@/lib/domain/users';
import { MIST, MONO } from '@/contours/users/lib/colors';
import { presetChoiceOf, presetChoicePatch } from '@/lib/domain/routingPresets';
import { NO_ACCESS_SQUAD_ID } from '@/lib/domain/squads';
export const LABEL = {
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: MIST,
  lineHeight: '12px',
};

export const GiB = 1_073_741_824;

export const STRATEGY_VALUES: TrafficLimitStrategy[] = ['no_reset', 'day', 'week', 'month', 'rolling'];

/**
 * Quick presets. Stored per browser rather than in the database: they are a
 * personal shortcut, the panel has no template table, and inventing one would
 * mean a migration for what is today one operator's muscle memory. Moving them
 * server-side later is additive.
 */

export interface FormValues {
  username: string;
  subscriptionToken: string;
  trafficLimitGb: number | '';
  trafficLimitStrategy: TrafficLimitStrategy;
  expireDays: number | '';
  /**
   * Whether this session actually chose an expiry. An edit that never touched
   * the field must send no date at all: restating one would recompute "now +
   * 30 days" on every save and walk the expiry forward a month at a time.
   */
  expirySet: boolean;
  status: 'active' | 'disabled';
  description: string;
  tag: string;
  email: string;
  telegramId: string;
  hwidDeviceLimit: number | '';
  groupIds: string[];
  routingPreset: string;
}

/**
 * What is wrong with a typed traffic limit, if anything (A-142). The server
 * takes whole GiB from 1 up, and an empty field is "no limit". A 0 is refused
 * by name: `Number(v) || null` used to turn it into "no limit" in silence,
 * the opposite of what anyone typing 0 means.
 */
export function trafficLimitProblem(gb: number | ''): 'zero' | null {
  return gb === 0 ? 'zero' : null;
}

/** The limit a save sends: null for an empty field, the number otherwise. */
export function trafficLimitInput(gb: number | ''): number | null {
  return gb === '' ? null : gb;
}

export function defaultValues(user: User | null): FormValues {
  return {
    username: user?.username ?? '',
    subscriptionToken: '',
    trafficLimitGb: user?.trafficLimitBytes != null ? Math.round(user.trafficLimitBytes / GiB) : '',
    trafficLimitStrategy: user?.trafficLimitStrategy ?? 'no_reset',
    expireDays: '',
    expirySet: false,
    // The form only says active or disabled; limited and expired are the
    // server's to give. Since 451640d (A-048, A-060) `active` is a request, not
    // an order: the server lands it on the status the facts give, so saving an
    // expired user whose date is still past keeps them expired, and an edit
    // that moves the date or raises the quota brings them back by itself.
    // `disabled` is taken as said.
    status: user?.status === 'disabled' ? 'disabled' : 'active',
    description: user?.description ?? '',
    tag: user?.tag ?? '',
    email: user?.email ?? '',
    telegramId: user?.telegramId ?? '',
    hwidDeviceLimit: user?.hwidDeviceLimit ?? '',
    groupIds: user?.groupIds ?? [],
    // One picker value for the pair: '' inherits, a built-in key or an own
    // preset's id (A-229).
    routingPreset: presetChoiceOf(user),
  };
}

/**
 * The PUT of an edit: only what the operator changed against the values the
 * drawer was seeded with (spec frontend-users, the PUT rule after the 31.07
 * incident). Restating every field rolled back what the operator's bot did
 * while the drawer was open: a renewal or a switch-on came back as the old
 * status and limit on save. Squads compare as a set; the expiry goes only when
 * this session picked one (`expirySet`), as before.
 */
export function userUpdatePatch(seed: FormValues, values: FormValues, chosenExpiry: Date | null): UpdateUserInput {
  const out: UpdateUserInput = {};
  if (values.expirySet) out.expireAt = chosenExpiry?.toISOString() ?? null;
  if (values.status !== seed.status) out.status = values.status;
  if (trafficLimitInput(values.trafficLimitGb) !== trafficLimitInput(seed.trafficLimitGb)) {
    out.trafficLimitGb = trafficLimitInput(values.trafficLimitGb);
  }
  if (values.trafficLimitStrategy !== seed.trafficLimitStrategy) out.trafficLimitStrategy = values.trafficLimitStrategy;
  const text = (v: string) => v || null;
  if (text(values.description) !== text(seed.description)) out.description = text(values.description);
  if (text(values.tag) !== text(seed.tag)) out.tag = text(values.tag);
  if (text(values.email) !== text(seed.email)) out.email = text(values.email);
  if (text(values.telegramId) !== text(seed.telegramId)) out.telegramId = text(values.telegramId);
  const limit = (v: number | '') => (v === '' ? null : Number(v));
  if (limit(values.hwidDeviceLimit) !== limit(seed.hwidDeviceLimit)) out.hwidDeviceLimit = limit(values.hwidDeviceLimit);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (!sameSet(values.groupIds, seed.groupIds)) out.groupIds = [...values.groupIds];
  return { ...out, ...presetChoicePatch(seed.routingPreset, values.routingPreset) };
}

/**
 * The squads offered to pick for a user. The compatibility API's "No access" is
 * not one to put a user in by hand; it is offered only to a user the facade
 * parked there, so the operator sees why they have nothing and can take them
 * out, and a save does not drop it unseen.
 */
export function squadChoicesFor<S extends { id: string }>(squads: S[], userGroupIds: readonly string[] | undefined): S[] {
  if (userGroupIds?.includes(NO_ACCESS_SQUAD_ID)) return squads;
  return squads.filter((s) => s.id !== NO_ACCESS_SQUAD_ID);
}
