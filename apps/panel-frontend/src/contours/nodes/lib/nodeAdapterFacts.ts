import type { UserScopeGap } from '@iceslab/shared';

/** Every gap the contract names: a Record over the shared union, so a new
 *  member is a type error here rather than a gap silently skipped. */
const KNOWN_GAPS: Record<UserScopeGap, true> = { 'shared-secret': true, 'shared-users': true };

type Served = { profileName: string; port: number };

/**
 * A-195: profiles that share a single-inbound adapter on this node. The node
 * serves one of them (`served`), the rest do not work but are handed out in
 * the subscription. `null`: the server is older than the field, say nothing;
 * `[]`: none. The input is checked first; a malformed entry is skipped.
 */
export function slotConflictsOf(raw: unknown): { protocol: string; served: Served | null; others: Served[] }[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: { protocol: string; served: Served | null; others: Served[] }[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const { protocol, bindings, servedBindingId } = c as { protocol?: unknown; bindings?: unknown; servedBindingId?: unknown };
    if (typeof protocol !== 'string' || !Array.isArray(bindings)) continue;
    const rows = bindings.filter(
      (b): b is { bindingId: string; profileName: string; port: number } =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as { bindingId?: unknown }).bindingId === 'string' &&
        typeof (b as { profileName?: unknown }).profileName === 'string' &&
        typeof (b as { port?: unknown }).port === 'number',
    );
    const served = rows.find((b) => b.bindingId === servedBindingId) ?? null;
    out.push({
      protocol,
      served: served ? { profileName: served.profileName, port: served.port } : null,
      others: rows.filter((b) => b !== served).map((b) => ({ profileName: b.profileName, port: b.port })),
    });
  }
  return out;
}

/**
 * A-204: bindings on this node where a squad's limit on a user does not hold,
 * with why. `null`: the server is older than the field; `[]`: none. The input
 * is checked first; a gap the contract does not name is skipped.
 */
export function userScopeGapsOf(raw: unknown): { profileName: string; port: number; gap: UserScopeGap }[] | null {
  if (raw === undefined || !Array.isArray(raw)) return null;
  return raw.flatMap((g) => {
    if (!g || typeof g !== 'object') return [];
    const { profileName, port, gap } = g as { profileName?: unknown; port?: unknown; gap?: unknown };
    if (typeof profileName !== 'string' || typeof port !== 'number' || typeof gap !== 'string') return [];
    if (!Object.hasOwn(KNOWN_GAPS, gap)) return [];
    return [{ profileName, port, gap: gap as UserScopeGap }];
  });
}
