/**
 * The name a subscriber's client shows for one way out of a cascade.
 *
 * In `shared` because both sides need the SAME string and for different
 * reasons. The backend serves it; the panel shows the operator what their
 * buyers will see before the save that changes it. A panel deriving its own
 * version would eventually show a name the subscription does not serve, and
 * this particular string is the one a client uses to tell one server from
 * another — get it wrong and the operator is reassured about the wrong thing.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;
const LETTER_A = 'A'.charCodeAt(0);

/**
 * ISO 3166-1 alpha-2 country code to its flag emoji.
 *
 * A flag emoji is a pair of Regional Indicator Symbols, one per letter, at
 * U+1F1E6 + (letter - 'A'). No table needed, and it works for codes we have
 * never heard of.
 */
export function countryFlagEmoji(code: string | null | undefined): string {
  if (!code) return '';
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '';
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + (upper.charCodeAt(0) - LETTER_A),
    REGIONAL_INDICATOR_A + (upper.charCodeAt(1) - LETTER_A),
  );
}

/**
 * The line a client shows for one way out of a cascade.
 *
 * What a subscriber picks here is a COUNTRY to leave from, so that is what the
 * label leads with. The exit node's name survives only as the fallback for a
 * node with no country set, where it is the sole thing distinguishing one way
 * out from another.
 *
 * An arrow, not a separator dot. The first half is the cascade's NAME, which an
 * operator usually takes from where the traffic ENTERS, and the second is where
 * it leaves. Written as "ru · NL" that reads as "ru via NL", i.e. backwards,
 * and it was read that way the first time an operator saw it.
 */
export function derivedCascadeLineLabel(
  cascadeName: string,
  exitCountryCode: string | null | undefined,
  exitNodeName: string,
): string {
  const flag = countryFlagEmoji(exitCountryCode);
  if (!flag) return `${cascadeName} → ${exitNodeName}`;
  return `${flag} ${cascadeName} → ${exitCountryCode!.toUpperCase()}`;
}

/** Blank is not a name. An operator who clears the box means "go back to the
 *  derived one", and storing '' would instead give every client an empty server
 *  name. */
export function normaliseLineLabel(label: string | null | undefined): string | null {
  const trimmed = (label ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
