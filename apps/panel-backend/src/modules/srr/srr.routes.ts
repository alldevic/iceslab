import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/auth.hook.js';
import { prisma } from '../../prisma.js';
import {
  CreateSrrSchema,
  UpdateSrrSchema,
  SrrIdParamSchema,
  TestSrrSchema,
} from './srr.schemas.js';
import { matchFormatForUserAgent, invalidateSrrCache } from './srr.service.js';
import { FORMAT_NAMES, type SubscriptionFormat } from '@iceslab/shared';
import { findTemplate, templateTypeForFormat } from '../subscription-templates/templates.service.js';

export async function srrRoutes(app: FastifyInstance): Promise<void> {
  // Wave-14 #15: per-route auth (see users.routes.ts header comment).
  const auth = { onRequest: [requireAuth] };

  // GET /api/srr: list rules in evaluation order (priority ASC)
  app.get('/api/srr', auth, async (_request, reply) => {
    const rules = await prisma.subscriptionResponseRule.findMany({
      orderBy: { priority: 'asc' },
    });
    return reply.send({ rules });
  });

  // POST /api/srr
  app.post('/api/srr', auth, async (request, reply) => {
    const input = CreateSrrSchema.parse(request.body);
    const refusal = await templateRefusal(input.format, input.templateName);
    if (refusal) return reply.code(400).send(refusal);
    try {
      const rule = await prisma.subscriptionResponseRule.create({
        data: input,
      });
      invalidateSrrCache();
      return reply.code(201).send(rule);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({
          error: 'CONFLICT',
          message: `Rule named "${input.name}" already exists`,
        });
      }
      throw err;
    }
  });

  // PUT /api/srr/:id
  app.put('/api/srr/:id', auth, async (request, reply) => {
    const params = SrrIdParamSchema.parse(request.params);
    const input = UpdateSrrSchema.parse(request.body);
    if (input.format !== undefined || input.templateName !== undefined) {
      // The pair as it will stand: what the request changes over what is stored.
      const stored = await prisma.subscriptionResponseRule.findUnique({
        where: { id: params.id },
        select: { format: true, templateName: true },
      });
      if (stored) {
        const refusal = await templateRefusal(
          input.format ?? stored.format,
          input.templateName !== undefined ? input.templateName : stored.templateName,
        );
        if (refusal) return reply.code(400).send(refusal);
      }
    }
    try {
      const rule = await prisma.subscriptionResponseRule.update({
        where: { id: params.id },
        data: input,
      });
      invalidateSrrCache();
      return reply.send(rule);
    } catch (err) {
      if (isRecordNotFoundError(err)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Rule not found' });
      }
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({
          error: 'CONFLICT',
          message: `Rule with that name already exists`,
        });
      }
      throw err;
    }
  });

  // DELETE /api/srr/:id
  app.delete('/api/srr/:id', auth, async (request, reply) => {
    const params = SrrIdParamSchema.parse(request.params);
    try {
      await prisma.subscriptionResponseRule.delete({
        where: { id: params.id },
      });
      invalidateSrrCache();
      return reply.code(204).send();
    } catch (err) {
      if (isRecordNotFoundError(err)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Rule not found' });
      }
      throw err;
    }
  });

  // POST /api/srr/test: evaluate a UA against the current rule set
  app.post('/api/srr/test', auth, async (request, reply) => {
    const input = TestSrrSchema.parse(request.body);
    const matched = await matchFormatForUserAgent(input.userAgent);
    return reply.send({ format: matched, userAgent: input.userAgent });
  });
}

/**
 * A-236: a rule names a template of the type its format is framed by, and one
 * that exists, or it is refused in words. (A template deleted later is not
 * refused at serve time: the clients fall back to the Default.)
 */
async function templateRefusal(
  format: string,
  templateName: string | null | undefined,
): Promise<{ error: string; message: string; field: string } | null> {
  if (templateName == null) return null;
  const type = isFormatName(format) ? templateTypeForFormat(format) : null;
  if (!type) {
    return {
      error: 'SRR_TEMPLATE_NOT_FOR_FORMAT',
      message: `the ${format} format takes no template; templates frame mihomo, clash, stash, clash-legacy, singbox, xrayjson and xrayjson-array`,
      field: 'templateName',
    };
  }
  if (!(await findTemplate(type, templateName))) {
    return {
      error: 'SRR_TEMPLATE_NOT_FOUND',
      message: `no ${type} template named ${JSON.stringify(templateName)}`,
      field: 'templateName',
    };
  }
  return null;
}

function isFormatName(v: string): v is SubscriptionFormat {
  return (FORMAT_NAMES as readonly string[]).includes(v);
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}

function isRecordNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2025';
}
