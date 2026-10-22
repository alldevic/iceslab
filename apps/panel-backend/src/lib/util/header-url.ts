/**
 * A URL in the form an HTTP header can carry, or null when it has none.
 *
 * A-168: `z.string().url()` accepts https://поддержка.рф/путь?q=привет, the
 * subscription put that value into the Support-URL header as it was, and Node
 * refuses a header with a non-ASCII character (ERR_INVALID_CHAR) before the
 * route gets to choose between the file and the page: one operator setting
 * took /sub down for every user.
 *
 * WHATWG serialisation is the cure, and it is the same string a browser
 * would follow: the host becomes punycode, the path, query and fragment are
 * percent-encoded. Anything still outside printable ASCII after that, or not
 * parseable at all, is null, so the caller leaves the header out instead of
 * failing the request.
 */
export function headerSafeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let href: string;
  try {
    href = new URL(raw).href;
  } catch {
    return null;
  }
  return /^[\x21-\x7e]+$/.test(href) ? href : null;
}
