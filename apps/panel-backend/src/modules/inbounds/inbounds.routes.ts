import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import { generateWireguardKeyPair, generateRealityKeyPair } from '../../lib/auth/credentials.js';

const KeypairQuery = z.object({
  protocol: z.enum(['xray', 'amneziawg']).default('amneziawg'),
});
import {
  CreateInboundSchema,
  UpdateInboundSchema,
  ListInboundsQuerySchema,
  InboundIdParamSchema,
} from './inbounds.schemas.js';
import * as inboundsService from './inbounds.service.js';
import { prisma } from '../../prisma.js';
import { withStoredSecrets } from '../auth/token-secrets.js';

export async function inboundsRoutes(app: FastifyInstance): Promise<void> {
  // Wave-14 #15: per-route auth (see users.routes.ts header comment).
  const auth = { onRequest: [requireAuth] };

  // Generate a curve25519 keypair for REALITY (Xray) or AmneziaWG. Same
  // crypto, different alphabet: REALITY needs base64url, AmneziaWG needs
  // standard base64. Pass `?protocol=xray` for the REALITY form. Default
  // is `amneziawg` to keep the original SPA call site working.
  app.post('/api/inbounds/generate-keypair', auth, async (request, reply) => {
    const { protocol } = KeypairQuery.parse(request.query);
    const pair = protocol === 'xray' ? generateRealityKeyPair() : generateWireguardKeyPair();
    return reply.send(pair);
  });

  app.post('/api/inbounds', auth, async (request, reply) => {
    const input = CreateInboundSchema.parse(request.body);
    try {
      const inbound = await inboundsService.createInbound(input);
      return reply.code(201).send(inbound);
    } catch (err) {
      if (err instanceof inboundsService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NODE_NOT_FOUND', message: err.message });
      }
      if (err instanceof inboundsService.PortInUseError) {
        return reply.code(409).send({ error: 'PORT_IN_USE', message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/inbounds', auth, async (request, reply) => {
    const query = ListInboundsQuerySchema.parse(request.query);
    return reply.send({ inbounds: await inboundsService.listInbounds(query) });
  });

  app.get('/api/inbounds/:id', auth, async (request, reply) => {
    const params = InboundIdParamSchema.parse(request.params);
    try {
      return reply.send(await inboundsService.getInboundById(params.id));
    } catch (err) {
      if (err instanceof inboundsService.InboundNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  app.put('/api/inbounds/:id', auth, async (request, reply) => {
    const params = InboundIdParamSchema.parse(request.params);
    // Not mounted since slice 27 (app.ts), and safe if it ever is again: a
    // restricted token reads without the server keys and must not wipe them
    // by writing the config back (A-109; realityPrivateKey defaults to '').
    const input = UpdateInboundSchema.parse(await withStoredSecrets(request, 'config', async () =>
      (await prisma.inbound.findUnique({ where: { id: params.id }, select: { config: true } }))?.config));
    try {
      return reply.send(await inboundsService.updateInbound(params.id, input));
    } catch (err) {
      if (err instanceof inboundsService.InboundNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof inboundsService.PortInUseError) {
        return reply.code(409).send({ error: 'PORT_IN_USE', message: err.message });
      }
      throw err;
    }
  });

  app.delete('/api/inbounds/:id', auth, async (request, reply) => {
    const params = InboundIdParamSchema.parse(request.params);
    try {
      await inboundsService.deleteInbound(params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof inboundsService.InboundNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });
}
