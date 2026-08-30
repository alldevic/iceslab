import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import {
  generateWireguardKeyPair,
  generateRealityKeyPair,
} from '../../lib/credentials.js';
import {
  BindingIdParamSchema,
  CreateBindingSchema,
  CreateProfileSchema,
  ListBindingsQuerySchema,
  ListProfilesQuerySchema,
  ProfileIdParamSchema,
  UpdateBindingSchema,
  UpdateProfileSchema,
} from './profiles.schemas.js';
import { resolveHostFields } from './host-fields.js';
import * as svc from './profiles.service.js';
import { generatePqKeys, NoKeygenNodeError, PQ_KEY_KINDS } from './pq-keys.js';

const KeypairQuery = z.object({
  // wireguard shares AmneziaWG's key format (standard base64) and so the same
  // generator; only REALITY needs the base64url alphabet.
  protocol: z.enum(['xray', 'amneziawg', 'wireguard']).default('amneziawg'),
});

/** U5 keygen: which material, and optionally which node should mint it. */
const PqKeygenSchema = z.object({
  kind: z.enum(PQ_KEY_KINDS),
  nodeId: z.uuid().optional(),
});

export async function profilesRoutes(app: FastifyInstance): Promise<void> {
  // Wave-14 #15: per-route auth (see users.routes.ts header comment).
  const auth = { onRequest: [requireAuth] };

  // curve25519 keypair for REALITY (xray) or AmneziaWG. Same crypto, the
  // alphabets differ, REALITY needs base64url, AWG needs standard base64.
  app.post('/api/profiles/generate-keypair', auth, async (req, reply) => {
    const { protocol } = KeypairQuery.parse(req.query);
    const pair =
      protocol === 'xray' ? generateRealityKeyPair() : generateWireguardKeyPair();
    return reply.send(pair);
  });

  /**
   * U5 - mint post-quantum key material on a NODE, because only the xray binary
   * can produce it and the panel has none. Without this an operator has to find
   * a box with the right build, run `xray mldsa65` / `xray vlessenc` by hand and
   * paste the result, which is how a shipped feature stays off.
   *
   * `nodeId` pins which node; without it the panel tries the likeliest online
   * ones. The node's raw output always comes back, so a build whose wording the
   * parser does not know still leaves the operator able to copy their key.
   */
  app.post('/api/profiles/generate-pq-keys', auth, async (req, reply) => {
    const { kind, nodeId } = PqKeygenSchema.parse(req.body);
    try {
      return reply.send(await generatePqKeys(kind, nodeId));
    } catch (err) {
      if (err instanceof NoKeygenNodeError) {
        return reply.code(503).send({ error: 'KEYGEN_UNAVAILABLE', message: err.message });
      }
      throw err;
    }
  });

  // ───── Profiles ─────

  app.post('/api/profiles', auth, async (req, reply) => {
    const input = CreateProfileSchema.parse(req.body);
    try {
      const p = await svc.createProfile(input);
      return reply.code(201).send(p);
    } catch (err) {
      if (err instanceof svc.ProfileNameTakenError) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/profiles', auth, async (req, reply) => {
    const q = ListProfilesQuerySchema.parse(req.query);
    return reply.send({ profiles: await svc.listProfiles(q) });
  });

  app.get('/api/profiles/:id', auth, async (req, reply) => {
    const { id } = ProfileIdParamSchema.parse(req.params);
    try {
      return reply.send(await svc.getProfileById(id));
    } catch (err) {
      if (err instanceof svc.ProfileNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // Which Host fields mean anything for this profile, plus what each one
  // inherits when the host leaves it NULL. The set depends on the profile's
  // config (transport, security layer), not just its protocol, so it is
  // resolved per profile rather than served as a static table. See
  // host-fields.ts for why most fields are dead outside xray.
  app.get('/api/profiles/:id/host-fields', auth, async (req, reply) => {
    const { id } = ProfileIdParamSchema.parse(req.params);
    try {
      const p = await svc.getProfileById(id);
      return reply.send({ fields: resolveHostFields(p.protocol, p.config) });
    } catch (err) {
      if (err instanceof svc.ProfileNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  app.put('/api/profiles/:id', auth, async (req, reply) => {
    const { id } = ProfileIdParamSchema.parse(req.params);
    const input = UpdateProfileSchema.parse(req.body);
    try {
      return reply.send(await svc.updateProfile(id, input));
    } catch (err) {
      if (err instanceof svc.ProfileNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof svc.ProfileNameTakenError) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      if (err instanceof svc.InvalidBindingConfigError) {
        return reply
          .code(400)
          .send({ error: 'INVALID_CONFIG', message: err.message, issues: err.issues });
      }
      // Its own code, not INVALID_CONFIG: nothing about the config is
      // malformed, and the same profile is fine against a node installed with a
      // wider range. What is wrong is the PAIR, and the message names both
      // halves plus the installer flag that would fix it from the other side.
      if (err instanceof svc.PortHoppingOutsideNodeRangeError) {
        return reply.code(400).send({
          error: 'PORT_HOPPING_OUTSIDE_NODE_RANGE',
          message: err.message,
          nodeName: err.nodeName,
        });
      }
      throw err;
    }
  });

  app.delete('/api/profiles/:id', auth, async (req, reply) => {
    const { id } = ProfileIdParamSchema.parse(req.params);
    try {
      await svc.deleteProfile(id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof svc.ProfileNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // ───── Bindings ─────

  app.post('/api/bindings', auth, async (req, reply) => {
    const input = CreateBindingSchema.parse(req.body);
    try {
      const b = await svc.createBinding(input);
      return reply.code(201).send(b);
    } catch (err) {
      if (err instanceof svc.ProfileNotFoundError || err instanceof svc.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (
        err instanceof svc.PortInUseError ||
        err instanceof svc.NodeAlreadyBoundError
      ) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      if (err instanceof svc.InvalidBindingConfigError) {
        return reply
          .code(400)
          .send({ error: 'INVALID_CONFIG', message: err.message, issues: err.issues });
      }
      // Its own code, not INVALID_CONFIG: nothing about the config is
      // malformed, and the same profile is fine against a node installed with a
      // wider range. What is wrong is the PAIR, and the message names both
      // halves plus the installer flag that would fix it from the other side.
      if (err instanceof svc.PortHoppingOutsideNodeRangeError) {
        return reply.code(400).send({
          error: 'PORT_HOPPING_OUTSIDE_NODE_RANGE',
          message: err.message,
          nodeName: err.nodeName,
        });
      }
      throw err;
    }
  });

  app.get('/api/bindings', auth, async (req, reply) => {
    const q = ListBindingsQuerySchema.parse(req.query);
    return reply.send({ bindings: await svc.listBindings(q) });
  });

  // F-P1-b: suggest a free listen port for a NEW binding on a node, so the
  // deploy modal stops defaulting to 443 (which 409s the moment a node already
  // runs a protocol there). Static path wins over `:id` in find-my-way.
  app.get('/api/bindings/next-free-port', auth, async (req, reply) => {
    const { nodeId } = z
      .object({ nodeId: z.string().uuid() })
      .parse(req.query);
    return reply.send({ port: await svc.nextFreePortForNode(nodeId) });
  });

  app.get('/api/bindings/:id', auth, async (req, reply) => {
    const { id } = BindingIdParamSchema.parse(req.params);
    try {
      return reply.send(await svc.getBindingById(id));
    } catch (err) {
      if (err instanceof svc.BindingNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  app.put('/api/bindings/:id', auth, async (req, reply) => {
    const { id } = BindingIdParamSchema.parse(req.params);
    const input = UpdateBindingSchema.parse(req.body);
    try {
      return reply.send(await svc.updateBinding(id, input));
    } catch (err) {
      if (err instanceof svc.BindingNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof svc.PortInUseError) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      if (err instanceof svc.InvalidBindingConfigError) {
        return reply
          .code(400)
          .send({ error: 'INVALID_CONFIG', message: err.message, issues: err.issues });
      }
      // Its own code, not INVALID_CONFIG: nothing about the config is
      // malformed, and the same profile is fine against a node installed with a
      // wider range. What is wrong is the PAIR, and the message names both
      // halves plus the installer flag that would fix it from the other side.
      if (err instanceof svc.PortHoppingOutsideNodeRangeError) {
        return reply.code(400).send({
          error: 'PORT_HOPPING_OUTSIDE_NODE_RANGE',
          message: err.message,
          nodeName: err.nodeName,
        });
      }
      throw err;
    }
  });

  app.delete('/api/bindings/:id', auth, async (req, reply) => {
    const { id } = BindingIdParamSchema.parse(req.params);
    try {
      await svc.deleteBinding(id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof svc.BindingNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });
}
