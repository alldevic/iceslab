import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/auth.hook.js';
import { prisma } from '../../prisma.js';

// A4 ad-split: a named route-policy (extra, ordinal >= 1) the operator can grant
// to squads. v1 is list-only; a create/edit surface is a fast-follow. The plain
// profile (ordinal 0) is implicit and never a row here.
export interface PublicRoutePolicyDto {
  id: string;
  name: string;
  ordinal: number;
  directDomains: string[];
  blockDomains: string[];
}

export async function listRoutePolicies(): Promise<PublicRoutePolicyDto[]> {
  const rows = await prisma.routePolicy.findMany({ orderBy: { ordinal: 'asc' } });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    ordinal: p.ordinal,
    directDomains: p.directDomains,
    blockDomains: p.blockDomains,
  }));
}

export async function routePolicyRoutes(app: FastifyInstance): Promise<void> {
  // Per-route auth (see users.routes.ts header for the Fastify v5 rationale).
  const auth = { onRequest: [requireAuth] };
  app.get('/api/route-policies', auth, async () => ({ policies: await listRoutePolicies() }));
}
