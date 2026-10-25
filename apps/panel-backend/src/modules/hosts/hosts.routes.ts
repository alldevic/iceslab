import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/auth.hook.js';
import {
  CreateHostSchema,
  HostIdParamSchema,
  ListHostsQuerySchema,
  ReorderHostsSchema,
  UpdateHostSchema,
} from './hosts.schemas.js';
import * as svc from './hosts.service.js';
import { getHostFreshness } from './hosts.freshness.js';
import { coreGateReply } from '../nodes/node-core-gate.js';

/**
 * The refusals of a new binding (or of a binding's move), in the bindings
 * route's bodies word for word, for create and for a port move (A-259): the
 * screen draws them with the words it already has whichever way it came.
 */
function newBindingRefusal(err: unknown): { status: number; body: Record<string, unknown> } | null {
  // The same three codes and the same union as the bindings route and the port check.
  if (
    err instanceof svc.PortInUseError ||
    err instanceof svc.PortHeldByCascadeError ||
    err instanceof svc.PortHeldByCoreServiceError
  ) {
    return { status: 409, body: { error: err.code, message: err.message, conflicts: err.conflicts } };
  }
  // A-055: the adapter holds one inbound and serves another host already.
  if (err instanceof svc.MieruMtuMismatchError) {
    return { status: 409, body: { error: err.code, message: err.message, nodeName: err.nodeName, mtu: err.mtu, wanted: err.wanted, heldBy: err.heldBy } };
  }
  if (err instanceof svc.AdapterSlotTakenError) {
    return {
      status: 409,
      body: { error: err.code, message: err.message, nodeName: err.nodeName, protocol: err.protocol, engine: err.engine, heldBy: err.heldBy },
    };
  }
  // The node's core for this profile is not installed, or runs a version this
  // panel refuses.
  const core = coreGateReply(err);
  if (core) return { status: core.status, body: core.body as Record<string, unknown> };
  // The node reported its engines and the profile's is not among them (A-161).
  if (err instanceof svc.ProfileDoesNotRunOnNodeError) {
    return {
      status: 409,
      body: {
        error: 'PROFILE_DOES_NOT_RUN_ON_NODE',
        message: err.message,
        nodeName: err.nodeName,
        neededEngine: err.neededEngine,
        reportedEngines: err.reportedEngines,
        canWait: err.canWait,
      },
    };
  }
  // An xray-family profile on sing-box with a field sing-box cannot serve.
  if (err instanceof svc.ProfileEngineNotForTransportError) {
    return { status: 400, body: { error: err.code, message: err.message, path: err.path } };
  }
  return null;
}

export async function hostsRoutes(app: FastifyInstance): Promise<void> {
  // Wave-14 #15: per-route auth (see users.routes.ts header comment).
  const auth = { onRequest: [requireAuth] };

  app.get('/api/hosts', auth, async (req, reply) => {
    const q = ListHostsQuerySchema.parse(req.query);
    return reply.send({ hosts: await svc.listHosts(q) });
  });

  app.get('/api/hosts/:id', auth, async (req, reply) => {
    const { id } = HostIdParamSchema.parse(req.params);
    try {
      return reply.send(await svc.getHostById(id));
    } catch (err) {
      if (err instanceof svc.HostNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // How many subscribers are still on the old link. Counts PEOPLE, not configs:
  // the question the screen asks is who cannot connect, and one person in two
  // squads is one person. Declared before the generic :id routes below purely
  // for readability, Fastify matches the static segment either way.
  app.get('/api/hosts/:id/freshness', auth, async (req, reply) => {
    const { id } = HostIdParamSchema.parse(req.params);
    const freshness = await getHostFreshness(id);
    if (!freshness) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(freshness);
  });

  app.post('/api/hosts', auth, async (req, reply) => {
    const input = CreateHostSchema.parse(req.body);
    try {
      const h = await svc.createHost(input);
      return reply.code(201).send(h);
    } catch (err) {
      if (
        err instanceof svc.BindingNotFoundError ||
        err instanceof svc.ProfileNotFoundError ||
        err instanceof svc.NodeNotFoundError
      ) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      // Creating a host can create the binding under it, so the refusals that
      // belong to the bindings route surface here too.
      const refused = newBindingRefusal(err);
      if (refused) return reply.code(refused.status).send(refused.body);
      // The form shows this next to the SNI field, so it carries the served
      // names rather than only prose.
      if (err instanceof svc.SniMismatchError) {
        return reply.code(400).send({
          error: 'SNI_MISMATCH',
          message: err.message,
          expected: err.expected,
        });
      }
      throw err;
    }
  });

  app.put('/api/hosts/:id', auth, async (req, reply) => {
    const { id } = HostIdParamSchema.parse(req.params);
    const input = UpdateHostSchema.parse(req.body);
    try {
      return reply.send(await svc.updateHost(id, input));
    } catch (err) {
      if (err instanceof svc.HostNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof svc.SniMismatchError) {
        return reply.code(400).send({
          error: 'SNI_MISMATCH',
          message: err.message,
          expected: err.expected,
        });
      }
      // A port move: the checks of the binding it moves or of the new binding a
      // host moved alone lands on (A-259), the same bodies as create.
      const refused = newBindingRefusal(err);
      if (refused) return reply.code(refused.status).send(refused.body);
      throw err;
    }
  });

  app.delete('/api/hosts/:id', auth, async (req, reply) => {
    const { id } = HostIdParamSchema.parse(req.params);
    try {
      await svc.deleteHost(id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof svc.HostNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  app.put('/api/hosts/reorder', auth, async (req, reply) => {
    const input = ReorderHostsSchema.parse(req.body);
    try {
      return reply.send({ hosts: await svc.reorderHosts(input) });
    } catch (err) {
      if (err instanceof svc.HostNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });
}
