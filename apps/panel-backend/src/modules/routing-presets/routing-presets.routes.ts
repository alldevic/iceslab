import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import { DeviceRouteRuleSchema, MAX_PRESET_RULES, RoutingPresetRulesError } from './routing-presets.rules.js';
import * as service from './routing-presets.service.js';

/**
 * A-229 part 2: /api/routing-presets. The shape is the one the panel's
 * editor is written against (panel-frontend lib/domain/routePolicies.ts,
 * RoutingPreset): { id, name, builtIn, rules: [{ id, match, action, note }] }.
 */

const NameSchema = z.string().trim().min(1, 'Name is required').max(64, 'Name too long');
const RulesSchema = z.array(DeviceRouteRuleSchema).max(MAX_PRESET_RULES);

const CreateSchema = z.object({ name: NameSchema, rules: RulesSchema });
// PUT: an absent key is not an edit.
const UpdateSchema = z.object({ name: NameSchema.optional(), rules: RulesSchema.optional() });
const IdParam = z.object({ id: z.uuid() });

function refusal(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof service.RoutingPresetBuiltInError) {
    return reply.code(403).send({ error: err.code, message: err.message });
  }
  if (err instanceof service.RoutingPresetMissingError) {
    return reply.code(404).send({ error: err.code, message: err.message });
  }
  if (err instanceof service.RoutingPresetNameTakenError) {
    return reply.code(409).send({ error: err.code, message: err.message, field: 'name' });
  }
  if (err instanceof service.RoutingPresetInUseError) {
    return reply.code(409).send({ error: err.code, message: err.message, ...err.use });
  }
  if (err instanceof RoutingPresetRulesError) {
    return reply.code(400).send({ error: err.code, message: err.message, entries: err.entries });
  }
  return null;
}

export async function routingPresetsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [requireAuth] };

  app.get('/api/routing-presets', auth, async (_req, reply) => {
    return reply.send({ presets: await service.listRoutingPresets() });
  });

  app.post('/api/routing-presets', auth, async (request, reply) => {
    const input = CreateSchema.parse(request.body);
    try {
      return reply.code(201).send(await service.createRoutingPreset(input));
    } catch (err) {
      const r = refusal(reply, err);
      if (r) return r;
      throw err;
    }
  });

  app.put('/api/routing-presets/:id', auth, async (request, reply) => {
    try {
      service.refuseBuiltIn((request.params as { id?: string }).id ?? '');
      const { id } = IdParam.parse(request.params);
      const input = UpdateSchema.parse(request.body);
      return reply.send(await service.updateRoutingPreset(id, input));
    } catch (err) {
      const r = refusal(reply, err);
      if (r) return r;
      throw err;
    }
  });

  app.delete('/api/routing-presets/:id', auth, async (request, reply) => {
    try {
      service.refuseBuiltIn((request.params as { id?: string }).id ?? '');
      const { id } = IdParam.parse(request.params);
      await service.deleteRoutingPreset(id);
      return reply.code(204).send();
    } catch (err) {
      const r = refusal(reply, err);
      if (r) return r;
      throw err;
    }
  });
}
