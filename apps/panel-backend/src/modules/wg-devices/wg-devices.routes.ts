import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import { listDevicesWithPeers, revokeDevice } from './wg-devices.service.js';

const UserIdParam = z.object({ userId: z.uuid() });
const DeviceIdParam = z.object({ id: z.uuid() });

/**
 * Admin routes for a user's WireGuard devices (milestone 9.6): the live ones
 * with what each moved and when it was last seen, and revocation. The private
 * and preshared keys never leave the panel but in the user's own configs.
 * The list is a user's own devices (at most MAX_WG_DEVICES), so it is not paged.
 */
export async function wgDevicesRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [requireAuth] };

  app.get('/api/users/:userId/wg-devices', auth, async (req, reply) => {
    const { userId } = UserIdParam.parse(req.params);
    const devices = await listDevicesWithPeers(userId);
    return reply.send({
      devices: devices.map((d, i) => ({
        id: d.id,
        userId: d.userId,
        // Its number among the live devices, the one `?device=` takes.
        index: i + 1,
        label: d.label,
        publicKey: d.publicKey,
        addresses: [...new Set(d.peers.map((p) => p.ip))],
        // Strings: a lifetime of bytes outgrows a JSON number's exact range.
        bytesIn: d.bytesIn.toString(),
        bytesOut: d.bytesOut.toString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  });

  app.delete('/api/wg-devices/:id', auth, async (req, reply) => {
    const { id } = DeviceIdParam.parse(req.params);
    const device = await revokeDevice(id);
    if (!device) return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such device' });
    return reply.code(204).send();
  });
}
