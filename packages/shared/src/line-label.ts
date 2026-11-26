/**
 * The names a subscriber's client shows for the lines of a cascade.
 *
 * In `shared` because both sides need the SAME string and for different
 * reasons: the backend serves it, the panel shows the operator what their
 * subscribers will see before the save that changes it. A panel deriving its
 * own version would eventually show a name the subscription does not serve, and
 * this is the string a client uses to tell one server from another.
 *
 * The functions take the country and the exit's name ALREADY RESOLVED (a
 * direction's own country, else its first node's, else its named outbound's):
 * which of those applies is the caller's lookup, and a second copy of it on
 * each side is how the two would drift.
 */

/** The longest pinned name: the column is VARCHAR(64). */
export const LINE_LABEL_MAX_LENGTH = 64;

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
 * The line a client shows for one way out of a cascade, derived.
 *
 * What a subscriber picks here is a COUNTRY to leave from, so that is what the
 * label leads with; the exit's name survives only as the fallback for an exit
 * with no country. An arrow, not a separator dot: the first half is the
 * cascade's NAME, usually taken from where the traffic ENTERS, and "ru · NL"
 * reads as "ru via NL", i.e. backwards.
 */
export function derivedDirectionLineLabel(
  cascadeName: string,
  exitCountryCode: string | null | undefined,
  exitName: string,
): string {
  const flag = countryFlagEmoji(exitCountryCode);
  if (!flag) return `${cascadeName} → ${exitName}`;
  return `${flag} ${cascadeName} → ${exitCountryCode!.toUpperCase()}`;
}

/**
 * The line a client shows for the AUTO way out: no country named, the entry
 * picks the fastest exit it can measure. Same shape as a direction's, with a
 * symbol in the flag's place. "Auto" stays in English: it is the word the
 * clients themselves use for this, in every locale.
 */
export function derivedAutoLineLabel(cascadeName: string): string {
  return `⚡ ${cascadeName} → Auto`;
}

/**
 * What an operator typed in a name box, as it is stored: trimmed, and blank
 * means "not pinned" (null). Storing '' would give every client an empty
 * server name. Longer than the column is cut by the schema's refusal before
 * it gets here; this does not truncate.
 */
export function normaliseLineLabel(label: string | null | undefined): string | null {
  const trimmed = (label ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
