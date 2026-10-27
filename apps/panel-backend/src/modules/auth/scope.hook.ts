import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { redactRepliesOf } from './token-secrets.js';

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
  // The chain password is read behind the same right as the bootstrap that
  // installs it (nodes/chain-secret.ts promises so), which is a POST:
  // nodes:write, not nodes:read (A-109).
  if (url === '/api/nodes/:id/chain-secret') return 'nodes:write';
  const resource = url.slice('/api/'.length).split('/')[0];
  if (!resource) return null;
  const verb = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
  return `${resource}:${verb}`;
}

/**
 * Remnawave-compat facade routes live at `/<prefix>/api/<resource>/...` under
 * Remnawave's resource names. Each maps to the NATIVE scope that guards the
 * same data, so a scoped token is bound on the facade exactly as on `/api/*`
 * (a token without users:write cannot create a user through the facade
 * either). A resource missing here is default-deny, and a 403 is the wrong
 * answer for the shop: it reads it as a permissions problem, not an absent
 * route, and retries forever.
 */
export const COMPAT_SCOPE_RESOURCE: Readonly<Record<string, string>> = {
  users: 'users',
  // Dropping a user's live sessions acts on that user's access, not on a node.
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

/** The native scope a facade route needs, or null (default-deny). */
export function requiredCompatScope(method: string, url: string | undefined, prefix: string): string | null {
  const base = `/${prefix}/api/`;
  if (!url || !url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  const resource = rest.split('/')[0];
  const native = resource ? COMPAT_SCOPE_RESOURCE[resource] : undefined;
  if (!native) return null;
  // Squad bulk actions rewrite USERS' membership, which native guards with
  // users:write (PUT /api/users/:id), so a squads:write token cannot change
  // anyone's access through them.
  if (native === 'squads' && url.includes('/bulk-actions/')) return 'users:write';
  // Per-user analytics carry usernames and traffic: users:read data, not the
  // version string system:read grants natively.
  if (
    resource === 'bandwidth-stats' &&
    (rest.includes('/users/') || rest.endsWith('/users') || rest.endsWith('/usage'))
  ) {
    return 'users:read';
  }
  // Aggregates are the native dashboard overview: dashboard:read.
  if (resource === 'system' && rest.startsWith('system/stats')) return 'dashboard:read';
  if (resource === 'bandwidth-stats') return 'dashboard:read';
  // What is left of `system` is the version probe: read.
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
 *
 * "By hand" went wrong (A-040, 22.10): route-policies, node-policies,
 * named-outbounds and geo-sets were never added, so no scoped token could be
 * given them and KNOWN_SCOPES refused them at mint. scope.routes.test.ts now
 * reads every `/api/<segment>` in the source and fails on one missing here.
 */
export const SCOPEABLE_RESOURCES = [
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
  'wg-devices',
  'settings',
  'recipes',
  'dashboard',
  'system',
  'route-policies',
  'node-policies',
  'named-outbounds',
  'geo-sets',
  'routing-presets',
  'subscription-templates',
] as const;

/** First segments a token can never reach, so no scope is offered for them. */
export const UNSCOPED_RESOURCES = ['api-tokens', 'auth', 'internal'] as const;

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

  const routeUrl = request.routeOptions?.url;
  const facade =
    config.REMNAWAVE_COMPAT_ENABLED && !!routeUrl && routeUrl.startsWith(`/${config.REMNAWAVE_COMPAT_PREFIX}/`);
  const required = facade
    ? requiredCompatScope(request.method, routeUrl, config.REMNAWAVE_COMPAT_PREFIX)
    : requiredScopeFor(request.method, routeUrl);
  if (!required || !scopes.includes(required)) {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: required
        ? `API token is missing the required scope (${required}) for this route`
        : 'API token scope does not grant access to this route',
    });
  }
  // Let in: what it reads goes out without server secrets (A-109).
  redactRepliesOf(request, reply);
}
