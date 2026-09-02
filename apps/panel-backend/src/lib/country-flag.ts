import {
  countryFlagEmoji,
  derivedCascadeLineLabel,
  normaliseLineLabel,
} from '@iceslab/shared';

export { normaliseLineLabel };

/**
 * ISO 3166-1 alpha-2 country code to its flag emoji.
 *
 * Used in the server names a client displays. The panel's own "what people see"
 * preview has always shown the flag; until 2026-07-30 the subscription itself
 * did not, so the preview and the client disagreed.
 *
 * The implementation lives in `shared` because the panel front-end needs the
 * same string: it shows the operator the name their buyers will see, and that
 * name is what a client identifies a server BY.
 */
export const countryFlag = countryFlagEmoji;

/**
 * The line a user reads in their client.
 *
 * A host's own name wins outright: it is the thing the operator wrote for
 * people to read, and repeating the internal node name in front of it ("ru-test1
 * · Ru-xhttp-reality") tells the user nothing they can act on. The node name is
 * the fallback for a host that was never named, which is what the auto-created
 * `Default` host is.
 *
 * The flag goes first because clients sort and truncate by this string, and a
 * leading flag survives truncation while a trailing one does not.
 */
export function subscriptionServerName(opts: {
  hostRemark?: string | null;
  nodeName: string;
  countryCode?: string | null;
}): string {
  const named = opts.hostRemark && opts.hostRemark !== 'Default' ? opts.hostRemark : opts.nodeName;
  const flag = countryFlag(opts.countryCode);
  return flag ? `${flag} ${named}` : named;
}

/**
 * The line a client shows for one way out of a cascade.
 *
 * What a subscriber picks here is a COUNTRY to leave from, so that is what the
 * label leads with. Until 2026-07-30 it read `se-01 · ru-01-xhttp-reality`,
 * gluing two of our internal names together: the exit machine and the host on
 * the entry the traffic happened to arrive through. Neither is a thing the
 * person choosing has an opinion about.
 *
 * The exit node name survives only as the fallback for a node with no country
 * set, where it is the sole thing distinguishing one way out from another.
 */
/**
 * The line a client shows for the AUTO way out: no country named, the entry
 * picks the fastest exit it can measure.
 *
 * Same shape as the per-direction label so the two sort together in a client
 * list, with a symbol in the flag's place: something has to occupy that column,
 * or the Auto row loses its left edge and stops looking like a sibling of the
 * rows above it. "Auto" stays in English deliberately: it is the word the
 * clients themselves use for this, in every locale.
 */
export function cascadeAutoProfileLabel(cascadeName: string): string {
  return `⚡ ${cascadeName} → Auto`;
}

/**
 * The line a client shows for one way out of a cascade.
 *
 * Kept under the name every caller here already uses; the formula lives in
 * `shared` because the panel front-end derives the same string to show the
 * operator what a save will do to their buyers' server lists.
 *
 * Until 2026-07-30 it read `se-01 · ru-01-xhttp-reality`, gluing two internal
 * names together: the exit machine and the host on the entry the traffic
 * happened to arrive through. Neither is a thing the person choosing has an
 * opinion about.
 */
export const cascadeProfileLabel = derivedCascadeLineLabel;

/**
 * The name one direction's line carries in a subscriber's client.
 *
 * One function, because this string IS the identity of a server to a client
 * that has no other: a client keying on the name treats a changed one as a new
 * server and keeps the old beside it. Two places computing it independently is
 * how one of them starts telling an operator a name the subscription does not
 * serve.
 *
 * A pinned label wins. Otherwise it is derived, as it always was, from the
 * cascade's name and the exit's country — with the exit NODE's name as the last
 * resort, which is the only thing left to tell two ways out apart when neither
 * carries a country.
 */
export function directionLineLabel(
  cascadeName: string,
  direction: {
    label?: string | null;
    countryCode?: string | null;
    nodes: { node: { name: string; countryCode: string | null } }[];
  },
): string {
  const pinned = normaliseLineLabel(direction.label);
  if (pinned) return pinned;
  const first = direction.nodes[0]?.node;
  return cascadeProfileLabel(
    cascadeName,
    direction.countryCode ?? first?.countryCode ?? null,
    first?.name ?? '',
  );
}
