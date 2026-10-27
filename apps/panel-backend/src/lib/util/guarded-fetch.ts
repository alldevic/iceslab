/**
 * Fetching an address an operator typed, with the guards a server owes it
 * (A-115): the host is not loopback, private, link-local or cloud metadata,
 * on the first request and on every redirect (followed by hand, a few at
 * most), and the body is read with a ceiling, refused as soon as it is
 * passed, not after it has all been held in memory.
 *
 * The recipe sources had these first (recipes.registry.ts, recipes.ssrf.ts);
 * the geo sets fetched with `redirect: 'follow'` and read the whole body
 * before looking at its size. One helper now, for both.
 *
 * DNS is not resolved: a public name that points at a private address is not
 * caught. Accepted for an admin-only setting, as it was for the recipes.
 */

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^127\./, // IPv4 loopback
  /^10\./, // IPv4 private
  /^192\.168\./, // IPv4 private
  /^172\.(1[6-9]|2\d|3[01])\./, // IPv4 private 172.16-31
  /^169\.254\./, // IPv4 link-local + cloud metadata (169.254.169.254)
  /^0\./, // this-network
];

/** Loopback, private, link-local, metadata, or a name that only means this
 *  machine or its network. */
export function isBlockedHost(host: string): boolean {
  // URL.hostname keeps the [] around an IPv6 literal, so strip them and the
  // bare-address checks below match (e.g. "[::1]" -> "::1").
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h === '0.0.0.0') {
    return true;
  }
  // IPv6 literals only (they contain a colon; a domain like "fc-cdn.com"
  // must not be blocked): loopback ::1, unique-local fc00::/7, link-local
  // fe80::/10.
  if (h.includes(':') && (h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h))) return true;
  // An IPv4 written as IPv6 is refused whole, whatever the IPv4: the
  // IPv4-mapped form (`[::ffff:127.0.0.1]` reaches here as `::ffff:7f00:1`)
  // and the NAT64 prefix 64:ff9b::/96 are both a road to an internal IPv4.
  if (h.includes(':') && (/^(0{0,4}:){0,5}:?ffff:/.test(h) || h.startsWith('::ffff:') || /^64:ff9b:(0{0,4}:){0,4}:?/.test(h))) {
    return true;
  }
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(h));
}

export class GuardedFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: 'address' | 'redirect' | 'too-large',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}

/** The URL, or a refusal in words: not http(s), or a host that is not public. */
export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GuardedFetchError(`"${raw}" is not a URL`, 'address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new GuardedFetchError(`only http and https are fetched, not ${u.protocol}`, 'address');
  }
  if (isBlockedHost(u.hostname)) {
    throw new GuardedFetchError(`the host ${u.hostname} is not fetched (loopback, private or metadata)`, 'address');
  }
  return u;
}

export const MAX_REDIRECTS = 3;

/**
 * fetch with every hop checked: redirects are followed by hand (at most
 * MAX_REDIRECTS), each Location resolved and checked like the first address.
 * Answers the last response, which is not a redirect.
 */
export async function fetchGuarded(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicHttpUrl(at);
    const res = await fetchImpl(at, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const loc = res.headers.get('location');
    if (!loc) throw new GuardedFetchError(`redirect ${res.status} without a Location from ${at}`, 'redirect', res.status);
    at = new URL(loc, at).toString();
  }
  throw new GuardedFetchError(`more than ${MAX_REDIRECTS} redirects from ${url}`, 'redirect');
}

/**
 * The body as bytes, refused as soon as it passes `maxBytes`: up front on a
 * Content-Length that says so, else while it streams, the rest never read.
 */
export async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new GuardedFetchError(`the body is larger than ${maxBytes} bytes`, 'too-large', res.status);
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw tooLarge();
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > maxBytes) throw tooLarge();
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
