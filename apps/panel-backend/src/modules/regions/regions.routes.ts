import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { requireAuth } from '../auth/auth.hook.js';
import { prisma } from '../../prisma.js';
import { isUniqueViolationOn } from '../../lib/util/unique-violation.js';

/**
 * Slice 27.5: admin CRUD for `regions`. Plain identity table with
 * (name, code), no business logic yet. Slice 28 will read `code`
 * against GeoIP at /sub/:token to score nodes; here we just give
 * admins the chair to create them.
 */

const RegionIdParam = z.object({ id: z.uuid() });

const CreateRegion = z.object({
  name: z.string().min(1).max(64),
  code: z.string().min(1).max(16),
});

const UpdateRegion = CreateRegion.partial();

function regionToDto(r: { id: string; name: string; code: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Which of the two unique fields a save collided on (A-257). The operator's
 * fix differs, rename or pick another code, so "name or code" is not an
 * answer. Read from the index the error names, never from meta.target, which
 * the pg adapter leaves empty. Any other P2002 is not ours to word.
 */
function regionClash(
  err: unknown,
  input: { name?: string; code?: string },
): { error: 'CONFLICT'; field: 'name' | 'code'; message: string } | null {
  if (isUniqueViolationOn(err, 'regions_name_key', ['name'])) {
    return { error: 'CONFLICT', field: 'name', message: `Region name "${input.name ?? ''}" is already taken` };
  }
  if (isUniqueViolationOn(err, 'regions_code_key', ['code'])) {
    return { error: 'CONFLICT', field: 'code', message: `Region code "${input.code ?? ''}" is already taken` };
  }
  return null;
}

export async function regionsRoutes(app: FastifyInstance): Promise<void> {
  // Wave-14 #15: per-route auth (see users.routes.ts header comment).
  const auth = { onRequest: [requireAuth] };

  app.get('/api/regions', auth, async (_req, reply) => {
    const rows = await prisma.region.findMany({
      orderBy: [{ name: 'asc' }],
      include: { _count: { select: { nodes: true } } },
    });
    return reply.send({
      regions: rows.map((r) => ({ ...regionToDto(r), nodeCount: r._count.nodes })),
    });
  });

  app.post('/api/regions', auth, async (req, reply) => {
    const input = CreateRegion.parse(req.body);
    try {
      const created = await prisma.region.create({ data: input });
      return reply.code(201).send(regionToDto(created));
    } catch (err) {
      const taken = regionClash(err, input);
      if (taken) return reply.code(409).send(taken);
      throw err;
    }
  });

  app.put('/api/regions/:id', auth, async (req, reply) => {
    const { id } = RegionIdParam.parse(req.params);
    const input = UpdateRegion.parse(req.body);
    try {
      const updated = await prisma.region.update({ where: { id }, data: input });
      return reply.send(regionToDto(updated));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2025') {
          return reply.code(404).send({ error: 'NOT_FOUND' });
        }
      }
      const taken = regionClash(err, input);
      if (taken) return reply.code(409).send(taken);
      throw err;
    }
  });

  app.delete('/api/regions/:id', auth, async (req, reply) => {
    const { id } = RegionIdParam.parse(req.params);
    // Foreign-key on `nodes.region_id` is ON DELETE SET NULL, we don't
    // need to clear nodes manually; they just become "regionless" again.
    try {
      await prisma.region.delete({ where: { id } });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      throw err;
    }
  });
}
