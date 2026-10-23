/**
 * How many bindings a profile has, for its card and the delete window (A-226).
 *
 * The binding list is the fresh answer; when it did not arrive (or is still on
 * its way) the profile's own `bindingCount` from the server stands in. It used
 * to be 0 there, and the delete window said «not bound anywhere, safe» over a
 * failed request for a profile deployed on several nodes.
 */
export function profileBindings(
  profile: { id: string; bindingCount: number },
  byProfile: ReadonlyMap<string, number>,
  listArrived: boolean,
): number {
  return listArrived ? (byProfile.get(profile.id) ?? 0) : profile.bindingCount;
}
