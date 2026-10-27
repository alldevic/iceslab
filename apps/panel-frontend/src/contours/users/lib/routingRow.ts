import type { DeliveryRouting, PresetRef } from '@/lib/domain/users';

/**
 * The routing row of the user card (A-229): which preset this person is
 * served, and from where.
 *
 * An existing user whose picker was not touched is read from the server's
 * resolution (GET /api/users/:id/delivery, `effectivePreset`, `userPreset`,
 * `squadPreset`): the same one the subscription makes, own presets included.
 * The older fields of that answer speak in built-in keys only, so an own
 * preset reads there as `user: null`, and a card built on them said «no
 * preset» for a user who has one.
 *
 * A draft (a new user, or a picker moved in this session) is not what the
 * server serves yet, so it is drawn from the form and the squads, as before.
 */
export type DeliveryView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; routing: DeliveryRouting | null };

export interface RoutingRow {
  value: string;
  note: { key: string; vars?: Record<string, string> } | null;
}

export function routingRow(a: {
  /** The picker now: '' inherits, a built-in key or an own preset's id. */
  draft: string;
  /** The picker as the drawer opened it; null while creating. */
  seed: string | null;
  delivery: DeliveryView;
  /** The squads' own choice as the form sees it (one squad, or a clash). */
  squads: { source: { choice: string; squad: string } | null; clash: boolean };
  /** A picker value's name; null for an own preset the list does not name. */
  choiceName: (choice: string) => string | null;
  refName: (ref: PresetRef) => string;
  words: { inherits: string; unnamed: string; unknown: string; loading: string };
}): RoutingRow {
  const { draft, seed, delivery, squads, words } = a;
  if (seed !== null && draft === seed) {
    if (delivery.kind === 'loading') return { value: words.loading, note: null };
    if (delivery.kind === 'failed') return { value: words.unknown, note: { key: 'userDrawer.routingFailed' } };
    const r = delivery.routing;
    if (r) {
      const value = a.refName(r.effective);
      if (r.user) return { value, note: { key: 'userDrawer.routingOwn' } };
      if (r.squad) {
        if (r.squadConflict) return { value, note: { key: 'userDrawer.routingClashChip' } };
        return squads.source
          ? { value, note: { key: 'userDrawer.routingFromSquad', vars: { squad: squads.source.squad } } }
          : { value, note: { key: 'userDrawer.routingFromSquads' } };
      }
      return { value, note: { key: 'userDrawer.routingFromPanel' } };
    }
    // A server without the resolved fields: the form's own reading below.
  }
  if (draft !== '') return { value: a.choiceName(draft) ?? words.unnamed, note: null };
  if (squads.clash) return { value: words.inherits, note: { key: 'userDrawer.routingClashChip' } };
  if (squads.source) {
    return {
      value: a.choiceName(squads.source.choice) ?? words.unnamed,
      note: { key: 'userDrawer.routingFromSquad', vars: { squad: squads.source.squad } },
    };
  }
  return { value: words.inherits, note: null };
}
