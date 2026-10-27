import { LogController, type FastifyInstance, type FastifyRequest, type RouteOptions } from 'fastify';
import { redactIp } from '../notify/telegram-notify.js';

/**
 * A-267: the request log never carries a secret of the URL in full, nor the
 * address of whoever asked for one.
 *
 * Fastify's own line ("incoming request") holds `req.url` whole and the
 * client's address, at info, which is the production level. A subscription
 * client polls `/sub/<token>` every few minutes, so the log was a list of
 * every subscriber's token beside their IP. The handler's own care (the
 * honey-token alert cuts the token) came after the line was written.
 *
 * The rule is the route's own spelling, not a list kept somewhere else: a
 * path parameter named `token` (or ending in `Token`) is a secret wherever a
 * route puts it. Every route is read as it is registered (onRoute), so a new
 * route with `:token` is covered the day it is added. The match is on the
 * path PREFIX up to the secret segment, so a request under such a route that
 * matches nothing (`/sub/<token>/x/y`, a 404) is masked too.
 *
 * Query keys that name a secret are masked by the same reasoning. None of the
 * routes takes one today; the rule is there so the first one is not missed.
 */

const SECRET_PARAM = /^token$|Token$/;
const SECRET_QUERY = /token|secret|password|passwd|key/i;
const MASK = '***';

/** Route prefixes up to a secret segment, by the route spelling they come from. */
const secretPrefixes = new Map<string, RegExp>();

/** The first characters stay, enough to tell two tokens apart in a log. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `${value.slice(0, 4)}${MASK}` : MASK;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `/sub/:token/:client` -> a regex matching `/sub/` and capturing the segment
 * after it. Null when the route has no secret parameter. Other parameters
 * before the secret match any one segment; a regex constraint on a parameter
 * (`:id(^\d+)`) is dropped, it only narrows what we would match anyway.
 */
export function secretPrefixOf(routeUrl: string): RegExp | null {
  const segments = routeUrl.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith(':')) {
      const name = seg.slice(1).replace(/\(.*$/, '').replace(/\?$/, '');
      if (SECRET_PARAM.test(name)) return new RegExp(`^${out.join('/')}/([^/?#]+)`);
      out.push('[^/?#]+');
    } else if (seg.includes('*') || seg.includes(':')) {
      // A wildcard or a parameter inside a segment: nothing after it is placed.
      return null;
    } else {
      out.push(escapeRe(seg));
    }
  }
  return null;
}

/** Registers the reading of every route as it is added. Call before the routes. */
export function watchSecretRoutes(app: FastifyInstance): void {
  app.addHook('onRoute', (opts: RouteOptions) => {
    const re = secretPrefixOf(opts.url);
    if (re) secretPrefixes.set(opts.url, re);
  });
}

/** Whether the path carries a secret segment, by the routes seen so far. */
function secretMatch(path: string): RegExpExecArray | null {
  for (const re of secretPrefixes.values()) {
    const m = re.exec(path);
    if (m) return m;
  }
  return null;
}

/** The URL as a log may hold it: secret segment and secret query values masked. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  let path = q >= 0 ? url.slice(0, q) : url;
  let query = q >= 0 ? url.slice(q + 1) : null;
  const m = secretMatch(path);
  if (m) {
    const start = m.index + m[0].length - m[1]!.length;
    path = `${path.slice(0, start)}${maskSecret(m[1]!)}${path.slice(m.index + m[0].length)}`;
  }
  if (query !== null) {
    query = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        let key = pair.slice(0, eq);
        try {
          key = decodeURIComponent(key);
        } catch {
          // A malformed key is kept as sent; it is checked as it stands.
        }
        return SECRET_QUERY.test(key) ? `${pair.slice(0, eq)}=${MASK}` : pair;
      })
      .join('&');
  }
  return query === null ? path : `${path}?${query}`;
}

/** Whether a request's URL carries a secret, so its requester is not kept whole either. */
export function carriesSecret(url: string): boolean {
  const q = url.indexOf('?');
  return secretMatch(q >= 0 ? url.slice(0, q) : url) !== null;
}

/**
 * The `req` serializer of the panel's logger: Fastify's own fields, the URL
 * redacted, and the address cut to /24 or /48 on a request that carries a
 * token (a subscriber polling their subscription, a node redeeming its
 * bootstrap). Takes the Fastify request, as Fastify hands it.
 */
export function serializeReq(req: FastifyRequest): Record<string, unknown> {
  const url = req.url ?? '';
  return {
    method: req.method,
    url: redactUrl(url),
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: carriesSecret(url) ? redactIp(req.ip) : req.ip,
    remotePort: carriesSecret(url) ? undefined : req.socket?.remotePort,
  };
}

/**
 * Fastify's 404 line puts the raw URL into the MESSAGE, where no serializer
 * reaches ("Route GET:/sub/<token>/x not found"). Same line, URL redacted.
 */
export class RedactingLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.info(`Route ${request.raw.method}:${redactUrl(request.raw.url ?? '')} not found`);
  }
}
