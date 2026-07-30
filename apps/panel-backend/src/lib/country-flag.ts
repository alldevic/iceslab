/**
 * ISO 3166-1 alpha-2 country code to its flag emoji.
 *
 * A flag emoji is a pair of Regional Indicator Symbols, one per letter, at
 * U+1F1E6 + (letter - 'A'). No table needed, and it works for codes we have
 * never heard of.
 *
 * Used in the server names a client displays. The panel's own "what people see"
 * preview has always shown the flag; until 2026-07-30 the subscription itself
 * did not, so the preview and the client disagreed.
 */
const REGIONAL_INDICATOR_A = 0x1f1e6;
const LETTER_A = 'A'.charCodeAt(0);

export function countryFlag(code: string | null | undefined): string {
  if (!code) return '';
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '';
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + (upper.charCodeAt(0) - LETTER_A),
    REGIONAL_INDICATOR_A + (upper.charCodeAt(1) - LETTER_A),
  );
}

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
