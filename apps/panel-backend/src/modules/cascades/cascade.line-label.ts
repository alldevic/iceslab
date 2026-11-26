import { derivedAutoLineLabel, derivedDirectionLineLabel, normaliseLineLabel } from '@iceslab/shared';

/** What the name of a direction's line is read from. Everything but the
 *  country is optional so a narrow row still type-checks. */
export interface LineLabelDirection {
  /** The operator's pinned name; null or absent derives it. */
  label?: string | null;
  countryCode: string | null;
  nodes: { node?: { name: string; countryCode: string | null } | null }[];
  /** Phase 10: a direction on a named outbound has no pool. */
  outbound?: { name: string; countryCode: string | null } | null;
}

/**
 * The line a subscriber's client shows for one direction: the pinned name when
 * there is one, else the derived `<flag> <cascade> → <CC>`.
 *
 * The country is the direction's own, then its first node's, or, for a
 * direction on a named outbound, the outbound's; the name behind the arrow,
 * shown only when there is no country, is the first node's or the outbound's.
 * The single place both the subscription and the save report read it, so the
 * two cannot name a line differently.
 */
export function directionLineName(cascadeName: string, d: LineLabelDirection): string {
  const pinned = normaliseLineLabel(d.label);
  if (pinned) return pinned;
  const exit = d.nodes[0]?.node ?? d.outbound ?? null;
  return derivedDirectionLineLabel(cascadeName, d.countryCode ?? exit?.countryCode, exit?.name ?? '');
}

/** The line for the Auto way out: pinned, else derived. */
export function autoLineName(c: { name: string; autoLabel?: string | null }): string {
  return normaliseLineLabel(c.autoLabel) ?? derivedAutoLineLabel(c.name);
}
