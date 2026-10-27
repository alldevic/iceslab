import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/auth.hook.js';
import { isRestrictedToken, withStoredSecrets } from '../auth/token-secrets.js';
import { prisma } from '../../prisma.js';
import {
  CreateNamedOutboundSchema,
  NamedOutboundIdParamSchema,
  UpdateNamedOutboundSchema,
} from './named-outbounds.schemas.js';
import * as svc from './named-outbounds.service.js';
import type { PublicNamedOutbound } from './named-outbounds.mapper.js';

/** The service's refusals, each under its own code and in machine form. */
function fail(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof svc.NamedOutboundNotFoundError) {
    return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
  }
  if (err instanceof svc.NamedOutboundNameTakenError) {
    return reply.code(409).send({ error: err.code, message: err.message, name: err.outboundName });
  }
  if (err instanceof svc.NamedOutboundInUseError) {
    return reply.code(409).send({ error: err.code, message: err.message, usedBy: err.usedBy });
  }
  if (err instanceof svc.NamedOutboundTypeNotForDirectionError) {
    return reply.code(409).send({ error: err.code, message: err.message, type: err.type, usedBy: err.usedBy });
  }
  if (err instanceof svc.NamedOutboundConfigInvalidError) {
    return reply.code(400).send({
      error: 'VALIDATION',
      message: err.message,
      issues: err.issues.map((i) => ({ path: ['config', ...i.path], message: i.message })),
    });
  }
  throw err;
}

/**
 * The upstream's own login (a socks way out's `password`) is somebody else's
 * credential: a token with restricted scopes reads without it and writes
 * keep it (A-109, 22.10). Here and not in SERVER_SECRET_KEYS: `password` is
 * also what a subscriber's endpoint carries, and sub:read exists to read it.
 */
const UPSTREAM_SECRETS: ReadonlySet<string> = new Set(['password']);

function forReader(req: FastifyRequest, o: PublicNamedOutbound): PublicNamedOutbound {
  if (!isRestrictedToken(req) || !o.config || typeof o.config !== 'object') return o;
  const { password: _hidden, ...config } = o.config as Record<string, unknown>;
  return { ...o, config };
}

/** Phase 10 (Э3.2): foreign ways out a cascade direction can stand on. */
export async function namedOutboundsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [requireAuth] };

  app.get('/api/named-outbounds', auth, async (req, reply) => {
    return reply.send({ outbounds: (await svc.listNamedOutbounds()).map((o) => forReader(req, o)) });
  });

  app.get('/api/named-outbounds/:id', auth, async (req, reply) => {
    const { id } = NamedOutboundIdParamSchema.parse(req.params);
    try {
      return reply.send(forReader(req, await svc.getNamedOutbound(id)));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.post('/api/named-outbounds', auth, async (req, reply) => {
    const input = CreateNamedOutboundSchema.parse(req.body);
    try {
      return reply.code(201).send(forReader(req, await svc.createNamedOutbound(input)));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.put('/api/named-outbounds/:id', auth, async (req, reply) => {
    const { id } = NamedOutboundIdParamSchema.parse(req.params);
    // The stored login only under the same type: under another one it is not
    // that type's field, and the strict per-type schema would refuse it.
    const input = UpdateNamedOutboundSchema.parse(
      await withStoredSecrets(
        req,
        'config',
        async () => {
          const row = await prisma.namedOutbound.findUnique({ where: { id }, select: { type: true, config: true } });
          const sentType = (req.body as { type?: unknown } | null)?.type;
          return row && (sentType === undefined || sentType === row.type) ? row.config : undefined;
        },
        UPSTREAM_SECRETS,
      ),
    );
    try {
      // The answer too: the stored password put back into this body above is
      // the one GET hides from a restricted token.
      return reply.send(forReader(req, await svc.updateNamedOutbound(id, input)));
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.delete('/api/named-outbounds/:id', auth, async (req, reply) => {
    const { id } = NamedOutboundIdParamSchema.parse(req.params);
    try {
      await svc.deleteNamedOutbound(id);
      return reply.code(204).send();
    } catch (err) {
      return fail(err, reply);
    }
  });
}
