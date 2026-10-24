/**
 * Guard for operator-configured recipe-source URLs.
 *
 * A recipe source is a URL the admin adds; the backend then fetches it. The
 * admin already has shell on the box, so this is defense-in-depth rather than
 * a hard trust boundary, but we still refuse the obvious SSRF footguns:
 * non-https schemes and hosts that are loopback / link-local / private / cloud
 * metadata literals. This does NOT resolve DNS, so a public name pointing at a
 * private IP is not caught; that is an accepted limitation for an admin-only,
 * admin-trusted setting in v1.
 */

// The host check is shared with the geo sets (A-115): lib/util/guarded-fetch.ts.
import { isBlockedHost } from '../../lib/util/guarded-fetch.js';

/**
 * Validate a recipe-source URL and return the parsed URL. Throws with a
 * human-readable message the routes surface as a 400. https-only; loopback /
 * private / metadata hosts are rejected.
 */
export function assertFetchableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Source URL is not a valid URL');
  }
  if (u.protocol !== 'https:') {
    throw new Error('Source URL must use https');
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error('Source URL host is not allowed (loopback / private / metadata)');
  }
  return u;
}
