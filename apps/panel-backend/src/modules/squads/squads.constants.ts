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

/**
 * Stable, well-known UUID for the remnawave-compat "no access" squad — a group
 * with NO profiles, so its members get an empty subscription. The facade maps a
 * Remnawave empty `activeInternalSquads` (zero squads = no access) onto this
 * group instead of the native ALL fallback (which would grant full access).
 * Created on demand (upsert-by-id) by the facade, and — like ALL — system-
 * managed: squads.service refuses to modify or delete it, so its members can
 * never be silently backstopped into ALL. A constant id (not a name lookup)
 * keeps it refactor-safe and free of stale-cache / rename hazards.
 */
export const NO_ACCESS_SQUAD_ID = '00000000-0000-0000-0000-000000000002';

/** Display name for the no-access squad row. */
export const NO_ACCESS_SQUAD_NAME = 'No access (remnawave-compat)';
