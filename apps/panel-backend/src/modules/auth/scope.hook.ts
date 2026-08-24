import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';

/**
 * Map an authenticated API-token request to the scope it requires. Returns null
 * when no scope grants this route, so a restricted token is denied by default
 * (least-privilege / fail-safe: a route nobody mapped is closed, not open).
 *
 * Convention: `<resource>:<verb>` where `resource` is the first path segment
 * after `/api/` and `verb` is `read` (GET/HEAD) or `write` (everything else).
 * Examples:
 *   GET    /api/users            -> users:read
 *   POST   /api/users            -> users:write
 *   PUT    /api/users/:id        -> users:write
 *   POST   /api/users/:id/revoke -> users:write
 *   GET    /api/nodes/:id        -> nodes:read
 * One special case: the per-user endpoints list reveals subscription config, so
 * it needs `sub:read` rather than `users:read`.
 */
export function requiredScopeFor(method: string, url: string | undefined): string | null {
  if (!url || !url.startsWith('/api/')) return null;
  if (url === '/api/users/:id/endpoints' && (method === 'GET' || method === 'HEAD')) {
    return 'sub:read';
  }
  const resource = url.slice('/api/'.length).split('/')[0];
  if (!resource) return null;
  const verb = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
  return `${resource}:${verb}`;
}

/**
 * Remnawave-compat facade routes live at `/<prefix>/api/<resource>/...` and use
 * Remnawave resource names that don't map 1:1 to the native scope resources.
 * This maps a facade route to the NATIVE scope a token must hold to reach it, so
 * a scoped token is bound on the facade exactly as it is on `/api/*` (a
 * dashboard:read-only token can NOT create/delete users via the facade). Returns
 * null → default-deny. Kept next to requiredScopeFor so the two stay in sync.
 */
const COMPAT_SCOPE_RESOURCE: Record<string, string> = {
  users: 'users',
  // Dropping a user's live sessions is an operation on THAT USER's access, not
  // on a node — same reasoning as the bulk-actions note below. Unmapped it
  // returns null, and null is default-deny: the shop's least-privilege
  // deployment token would take a 403, which its client reads as a permissions
  // problem rather than an absent route, so it retries the doomed call forever
  // instead of falling back.
  connections: 'users',
  'internal-squads': 'squads',
  'external-squads': 'squads',
  hwid: 'hwid-devices',
  nodes: 'nodes',
  hosts: 'hosts',
  system: 'system',
  'bandwidth-stats': 'system',
  subscriptions: 'sub',
  'subscription-page-configs': 'sub',
  sub: 'sub',
};

export function requiredCompatScope(
  method: string,
  url: string | undefined,
  prefix: string,
): string | null {
  const base = `/${prefix}/api/`;
  if (!url || !url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  const resource = rest.split('/')[0];
  const native = resource ? COMPAT_SCOPE_RESOURCE[resource] : undefined;
  if (!native) return null;
  // Squad bulk-actions (add-/remove-users) rewrite a USER's group membership
  // (that user's access), which native gates behind users:write via PATCH
  // /api/users — not a squad-row op. Require users:write for parity, so a
  // squads:write-only token can't silently alter arbitrary users' access.
  if (native === 'squads' && url.includes('/bulk-actions/')) return 'users:write';
  // Per-user analytics (/bandwidth-stats/users/:uuid and
  // /bandwidth-stats/nodes/:uuid/users) return user identity + usage — that is
  // users:read data, NOT system:read (which natively grants only the version
  // string). Bind them to users:read so a system/dashboard-scoped monitoring
  // token can't enumerate per-user PII (usernames + traffic).
  // `nodes/usage` belongs here too: it returns per-user identity and totals for a
  // set of nodes, which is the same PII as the /users variants. Left to the
  // generic mapping it would resolve to system:write, which is both wrong about
  // what it reads and unreachable for the shop's users/squads-scoped token.
  if (
    resource === 'bandwidth-stats' &&
    (rest.includes('/users/') || rest.endsWith('/users') || rest.endsWith('/usage'))
  ) {
    return 'users:read';
  }
  // Aggregate analytics (/system/stats* and /bandwidth-stats top-level) are
  // dashboard-level; native puts the equivalent overview behind dashboard:read.
  // So a bare system:read token — which natively sees only the version — cannot
  // read panel-wide stats through the facade either.
  if (resource === 'system' && rest.startsWith('system/stats')) return 'dashboard:read';
  if (resource === 'bandwidth-stats') return 'dashboard:read';
  // The facade's only remaining `system` route is the happ-encrypt probe, which
  // always 404s (feature disabled) and does nothing privileged. Treat facade
  // `system` routes as read so a least-privilege token (system:read) reaches
  // them and gets the intended 404 instead of a 403.
  const verb = native === 'system' || method === 'GET' || method === 'HEAD' ? 'read' : 'write';
  return `${native}:${verb}`;
}

/**
 * Resources a scoped API token can legitimately be granted, i.e. the first
 * path segment after `/api/` for every token-reachable route (see
 * requiredScopeFor). Kept in sync with the routes by hand. `api-tokens`,
 * `auth` and `internal` are omitted on purpose: tokens can never reach those
 * (blockApiTokenAccess / login / node-only), so granting them would be a
 * dead scope.
 */
const SCOPEABLE_RESOURCES = [
  'users',
  'nodes',
  'profiles',
  'bindings',
  'hosts',
  'squads',
  'srr',
  'regions',
  'inbounds',
  'cascades',
  'hwid-devices',
  'settings',
  'recipes',
  'dashboard',
  'system',
] as const;

/**
 * The set of scopes a token may carry: `*` (full), the special `sub:read`
 * (the per-user endpoints route), and `<resource>:read|write` for every
 * scopeable resource. Used to validate scopes at mint time so a typo like
 * `user:read` (vs `users:read`) is rejected instead of silently producing a
 * token that matches no route and 403s everywhere (a fail-closed footgun).
 */
export const KNOWN_SCOPES: ReadonlySet<string> = new Set<string>([
  '*',
  'sub:read',
  ...SCOPEABLE_RESOURCES.flatMap((r) => [`${r}:read`, `${r}:write`]),
]);

/** True if `scope` is a scope the panel actually recognises (see KNOWN_SCOPES). */
export function isKnownScope(scope: string): boolean {
  return KNOWN_SCOPES.has(scope);
}

/**
 * Global preHandler that enforces API-token scopes. It runs AFTER route-level
 * `requireAuth` (onRequest), so `request.apiToken` is already populated when a
 * request authenticated via an `icp_*` token. No-op for:
 *   - non-token requests: admin-JWT sessions and public routes leave
 *     `request.apiToken` unset and keep full access.
 *   - full / legacy tokens: empty scopes, or scopes containing `*`.
 * A token carrying explicit scopes may only reach routes whose required scope
 * it holds; anything else is 403 (default-deny).
 */
export async function enforceScopes(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.apiToken;
  if (!token) return; // admin JWT or public route, not scope-restricted
  const scopes = token.scopes;
  if (scopes.length === 0 || scopes.includes('*')) return; // full / legacy token

  // The remnawave-compat facade (/<prefix>/api/*) uses Remnawave resource names
  // that don't match the native <resource>:<verb> convention, so requiredScopeFor
  // would return null (→ default-deny) and lock the intended facade token out.
  // Map each facade route to the equivalent NATIVE scope and enforce THAT, so a
  // scoped token is bound on the facade exactly as on /api/* — a token without
  // users:write can't create/delete users through the facade either. No-op unless
  // the facade is enabled.
  const routeUrl = request.routeOptions?.url;
  if (
    config.REMNAWAVE_COMPAT_ENABLED &&
    routeUrl &&
    routeUrl.startsWith(`/${config.REMNAWAVE_COMPAT_PREFIX}/`)
  ) {
    const requiredCompat = requiredCompatScope(
      request.method,
      routeUrl,
      config.REMNAWAVE_COMPAT_PREFIX,
    );
    if (!requiredCompat || !scopes.includes(requiredCompat)) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: requiredCompat
          ? `API token is missing the required scope (${requiredCompat}) for this facade route`
          : 'API token scope does not grant access to this facade route',
      });
    }
    return;
  }

  const required = requiredScopeFor(request.method, routeUrl);
  if (!required || !scopes.includes(required)) {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: required
        ? `API token is missing the required scope (${required}) for this route`
        : 'API token scope does not grant access to this route',
    });
  }
}
