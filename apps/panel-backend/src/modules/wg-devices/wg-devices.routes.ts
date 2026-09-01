import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import * as svc from './wg-devices.service.js';

const UserIdParam = z.object({ userId: z.uuid() });
const DeviceIdParam = z.object({ id: z.uuid() });

/**
 * Admin routes for a buyer's WireGuard devices.
 *
 * Deliberately separate from `/api/users/:id/hwid-devices` next door, because
 * the two answer different questions. HWID records what a client SAID about
 * itself when it polled the subscription - lazily, only for the clients that
 * send the header, and trivially spoofable. These rows are credentials the
 * panel issued: their count is what the nodes enforce, their traffic is
 * measured by the nodes themselves, and revoking one takes a tunnel down.
 *
 * `lastSeenAt` here means "moved bytes in some poll", not "handshaked": the
 * node's stats call reports counters, and a peer can hold a handshake while
 * sending nothing.
 */
export async function wgDeviceRoutes(app: FastifyInstance): Promise<void> {
  const auth = { onRequest: [requireAuth] };

  app.get('/api/users/:userId/wg-devices', auth, async (req, reply) => {
    const { userId } = UserIdParam.parse(req.params);
    const devices = await svc.listDevicesWithPeers(userId);
    return reply.send({
      devices: devices.map((d) => ({
        id: d.id,
        userId: d.userId,
        label: d.label,
        // The public key identifies the peer on the node, so an operator
        // reading `awg show` can match a line to a row here. The private key
        // is never exposed: it is the buyer's, and the panel has no reason to
        // show it outside the config it hands them.
        publicKey: d.publicKey,
        addresses: d.peers.map((p) => p.ip),
        bytesIn: d.bytesIn.toString(),
        bytesOut: d.bytesOut.toString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        revokedAt: d.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  // Revoke, not delete: the row and its traffic stay, the peer leaves every
  // node. Deleting would free the address for the next device allocated, and
  // the revoked config would become a working config again for someone else.
  app.delete('/api/wg-devices/:id', auth, async (req, reply) => {
    const { id } = DeviceIdParam.parse(req.params);
    const device = await svc.revokeDevice(id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    return reply.code(204).send();
  });
}
