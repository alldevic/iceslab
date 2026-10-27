import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Server secrets and API tokens with restricted scopes (A-109, 22.10).
 *
 * A token given `profiles:read` or `bindings:read` ("let the dashboard see
 * the protocols") got every profile's server material with the config: the
 * REALITY and AmneziaWG private keys, enough to stand up a server the
 * operator's clients take for theirs. A token with restricted scopes (not
 * empty, not `*`) now gets these keys removed from whatever it reads, and a
 * write of such a token that leaves one out keeps the stored value, so a bot
 * reading and writing back a config does not wipe the keys. Sessions and full
 * tokens are unchanged: the forms need the keys, and moving profiles between
 * panels needs them in the API.
 *
 * Decided by ARCH 22.10 over a separate `secrets:read` scope (one more button
 * to hand the keys out by mistake) and over keeping them from every token
 * (breaks moving profiles).
 */

/** Profile config and binding override keys that are server material
 *  (inbounds.schemas.ts: hysteria obfs, xray TLS key and REALITY private key,
 *  AmneziaWG server key, shadowsocks and shadowtls keys). */
export const SERVER_SECRET_KEYS: ReadonlySet<string> = new Set([
  'obfsPassword',
  'tlsKey',
  'realityPrivateKey',
  'serverPrivateKey',
  'serverPsk',
  'ssPassword',
]);

/** A token with restricted scopes: not a session, not a full or `*` token. */
export function isRestrictedToken(request: FastifyRequest): boolean {
  const scopes = request.apiToken?.scopes;
  return !!scopes && scopes.length > 0 && !scopes.includes('*');
}

/** The value with every SERVER_SECRET_KEYS key removed, at any depth. A new
 *  value; the input is not changed. */
export function withoutServerSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutServerSecrets);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SERVER_SECRET_KEYS.has(k)) out[k] = withoutServerSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * The reply of a restricted token is serialised without the secrets. Set from
 * the scope hook (enforceScopes), per reply, so no route has to remember it.
 */
export function redactRepliesOf(request: FastifyRequest, reply: FastifyReply): void {
  if (!isRestrictedToken(request) || typeof reply.serializer !== 'function') return;
  reply.serializer((payload: unknown) => JSON.stringify(withoutServerSecrets(payload)));
}

/**
 * A config or overrides object as a restricted token sent it, with each
 * secret it left out taken from the stored one: the token never saw the key,
 * and its absence is not an edit (the rule for PUT payloads). A key it sends
 * is its edit and stands. Non-objects come back as they are.
 */
export function keepStoredSecrets(
  sent: unknown,
  stored: unknown,
  keys: ReadonlySet<string> = SERVER_SECRET_KEYS,
): unknown {
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) return sent;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return sent;
  const out: Record<string, unknown> = { ...(sent as Record<string, unknown>) };
  for (const key of keys) {
    if (!(key in out) && key in (stored as Record<string, unknown>)) {
      out[key] = (stored as Record<string, unknown>)[key];
    }
  }
  return out;
}

/**
 * The body of a PUT, with the secrets a restricted token left out of `field`
 * taken from the stored row: that token reads without them, and writing back
 * what it read must not wipe them. On the edge of the request, before
 * validation, so the gates see what will be stored. Every PUT whose body
 * carries a config or overrides goes through this (create has nothing stored).
 * `stored` returns undefined when there is nothing to keep (no row, or a
 * stored value that would not belong under the new body).
 *
 * In the routes for now, reading prisma there (P9): in the queue after Э4.
 */
export async function withStoredSecrets(
  req: FastifyRequest,
  field: string,
  stored: () => Promise<unknown>,
  keys: ReadonlySet<string> = SERVER_SECRET_KEYS,
): Promise<unknown> {
  const body = req.body as Record<string, unknown> | null | undefined;
  if (!isRestrictedToken(req) || !body || typeof body !== 'object' || !(field in body)) return req.body;
  return { ...body, [field]: keepStoredSecrets(body[field], await stored(), keys) };
}
