import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEMPLATE_TYPES } from '@iceslab/shared';
import { requireAuth } from '../auth/auth.hook.js';
import { TemplateInvalidError } from './templates.parse.js';
import * as service from './templates.service.js';

/**
 * A-236 step 2: /api/subscription-templates, the API contract 4.5a
 * (docs/plan/subscription-templates.md). The dry run (POST /dry-run) comes
 * with the rendering in step 3, the import (POST /import) with step 8; until
 * then they answer 404, which the screen reads as "not here yet".
 */

/** 256 KiB: a big operator template is a few hundred lines. */
const BODY_MAX = 256 * 1024;
const Name = z.string().trim().min(1, 'Name is required').max(64, 'Name too long');
const Body = z.string().max(BODY_MAX, 'the template is larger than 256 KiB');

const CreateSchema = z.object({ type: z.enum(TEMPLATE_TYPES), name: Name, body: Body });
// PUT: an absent key is not an edit; the type is not changed (a frame of one
// format is not a frame of another).
const UpdateSchema = z.object({ name: Name.optional(), body: Body.optional() });
const IdParam = z.object({ id: z.uuid() });

function refusal(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof TemplateInvalidError) {
    return reply.code(400).send({
      error: err.code,
      message: err.message,
      ...(err.line !== undefined ? { line: err.line } : {}),
      ...(err.column !== undefined ? { column: err.column } : {}),
    });
  }
  if (err instanceof service.TemplateNameTakenError) {
    return reply.code(409).send({ error: err.code, message: err.message, field: 'name' });
  }
  if (err instanceof service.TemplateDefaultProtectedError) {
    return reply.code(409).send({ error: err.code, message: err.message });
  }
  if (err instanceof service.TemplateNotDefaultError) {
    return reply.code(409).send({ error: err.code, message: err.message });
  }
  if (err instanceof service.TemplateNotFoundError) {
    return reply.code(404).send({ error: err.code, message: err.message });
  }
  return null;
}

export async function subscriptionTemplatesRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [requireAuth] };
  const guarded = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (err) {
        const r = refusal(reply, err);
        if (r) return r;
        throw err;
      }
    };

  app.get('/api/subscription-templates', auth, async (_req, reply) => {
    return reply.send({ templates: await service.listTemplates() });
  });

  app.post('/api/subscription-templates', auth, guarded(async (req, reply) => {
    const input = CreateSchema.parse(req.body);
    return reply.code(201).send(await service.createTemplate(input));
  }));

  app.put('/api/subscription-templates/:id', auth, guarded(async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const input = UpdateSchema.parse(req.body);
    return reply.send(await service.updateTemplate(id, input));
  }));

  app.delete('/api/subscription-templates/:id', auth, guarded(async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    await service.deleteTemplate(id);
    return reply.code(204).send();
  }));

  app.post('/api/subscription-templates/:id/restore-default', auth, guarded(async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return reply.send(await service.restoreDefault(id));
  }));
}
