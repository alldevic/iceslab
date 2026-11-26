/**
 * Stable, well-known UUID for the "All" squad. Seeded by the
 * `20260507180000_seed_all_squad` migration; referenced by app code without
 * a query.
 *
 * Why a constant UUID rather than a "name=All" lookup: cheap, refactor-safe,
 * lets us flag the row as system-owned in the UI ("All" is read-only for
 * humans, admins can't rename or delete it because user-creation always
 * falls back here when no explicit groups are chosen).
 */
export const ALL_SQUAD_ID = '00000000-0000-0000-0000-000000000001';

/** Display name shown in panel UI; matches the seeded row's `name` column. */
export const ALL_SQUAD_NAME = 'All';

/**
 * Stable UUID of the "no access" squad: a group with no profiles, so its
 * members get an empty subscription. Remnawave reads an empty squad set as no
 * access where native would put the user in "All" (full access), so with the
 * facade on the users of a deleted squad are parked here instead. Unlike "All"
 * it is not seeded: it is created on demand (ensureNoAccessSquad), and like
 * "All" it cannot be edited or deleted.
 */
export const NO_ACCESS_SQUAD_ID = '00000000-0000-0000-0000-000000000002';

/** Display name of the "no access" squad row. */
export const NO_ACCESS_SQUAD_NAME = 'No access';
