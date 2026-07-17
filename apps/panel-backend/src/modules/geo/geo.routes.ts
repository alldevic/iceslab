import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.hook.js';
import {
  addSource,
  deleteSource,
  getSources,
  updateSource,
  getSourceById,
  reorderSources,
} from './geo.sources.js';
import { listSourceCategories, previewSourceCategory } from './geo.inspect.js';
import {
  addCategory,
  deleteCategory,
  getCategories,
  updateCategory,
  GeoCategoryNameConflict,
} from './geo.categories.js';
import {
  GeoSourceInputSchema,
  GeoSourceUpdateSchema,
  GeoSourceOrderSchema,
  GeoCategoryInputSchema,
  GeoCategoryUpdateSchema,
} from './geo.schemas.js';
import { assertFetchableUrl } from '../recipes/recipes.ssrf.js';
import {
  getGeoArtifact,
  getGeoBuildMeta,
  rebuildGeo,
  GeoBuildAllSourcesFailed,
} from './geo.registry.js';
import { geoArtifactToken } from './geo.url.js';

// Servable artifact names (custom .dat / mirror .dat / per-category .srs). The
// registry only returns names it actually built, so this just bounds the shape.
const ArtifactName = z.string().regex(/^[A-Za-z0-9._-]+$/).max(64);

/**
 * G1 - geo-source registry endpoints. Operator-managed upstream geosite/geoip
 * sources (bring your own geo) the builder (G2) mirrors + minimises. Mirrors the
 * recipe-source routes (recipes.routes.ts).
 *
 *   GET    /api/geo/sources     list configured sources (+ curated default)
 *   POST   /api/geo/sources     add a source
 *   PATCH  /api/geo/sources/:id enable / rename / repoint a source
 *   DELETE /api/geo/sources/:id remove a source
 */
const IdParam = z.object({ id: z.string().min(1).max(64) });

function badUrl(reply: FastifyReply, err: unknown): FastifyReply {
  return reply.code(400).send({ error: 'BAD_SOURCE', message: (err as Error).message });
}

// Guard each present URL so a bad one is a clean 400 (DB failures inside the
// service still propagate to the global 500 handler).
function guardUrls(geositeUrl?: string | null, geoipUrl?: string | null): void {
  if (geositeUrl) assertFetchableUrl(geositeUrl);
  if (geoipUrl) assertFetchableUrl(geoipUrl);
}

export async function geoRoutes(app: FastifyInstance): Promise<void> {
  // Per-route auth (see users.routes.ts header comment). Admin-only.
  const auth = { onRequest: [requireAuth] };

  app.get('/api/geo/sources', auth, async (_req, reply) => {
    return reply.send({ sources: await getSources() });
  });

  app.post('/api/geo/sources', auth, async (req, reply) => {
    const input = GeoSourceInputSchema.parse(req.body);
    try {
      guardUrls(input.geositeUrl, input.geoipUrl);
    } catch (err) {
      return badUrl(reply, err);
    }
    const created = await addSource(input);
    return reply.code(201).send(created);
  });

  app.patch('/api/geo/sources/:id', auth, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const patch = GeoSourceUpdateSchema.parse(req.body);
    try {
      guardUrls(patch.geositeUrl, patch.geoipUrl);
    } catch (err) {
      return badUrl(reply, err);
    }
    const updated = await updateSource(id, patch);
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(updated);
  });

  // Reorder = set source priority (first enabled with a db wins the client-facing
  // full-db mirror). Registered before the :id routes so 'order' isn't parsed as
  // an id (both are GET/PUT-distinct here, but keep it explicit).
  app.put('/api/geo/sources/order', auth, async (req, reply) => {
    const { ids } = GeoSourceOrderSchema.parse(req.body);
    return reply.send({ sources: await reorderSources(ids) });
  });

  app.delete('/api/geo/sources/:id', auth, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ok = await deleteSource(id);
    if (!ok) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  // Browse the categories a source's geosite/geoip .dat actually contains (name
  // + entry count), so the operator knows what to reference. Reuses the build's
  // cached bytes (ifDue), so it doesn't re-download a fresh source.
  app.get('/api/geo/sources/:id/categories', auth, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const source = await getSourceById(id);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(await listSourceCategories(source));
  });

  // Sample one category's entries (domains for geosite, CIDRs for geoip), capped.
  app.get('/api/geo/sources/:id/categories/:kind/:name', auth, async (req, reply) => {
    const params = z
      .object({
        id: z.string().min(1).max(64),
        kind: z.enum(['geosite', 'geoip']),
        name: z.string().min(1).max(128),
      })
      .parse(req.params);
    const source = await getSourceById(params.id);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND' });
    const preview = await previewSourceCategory(source, params.kind, params.name);
    if (!preview) return reply.code(404).send({ error: 'CATEGORY_NOT_FOUND' });
    return reply.send(preview);
  });

  // ───── custom categories (G3) ─────
  app.get('/api/geo/categories', auth, async (_req, reply) => {
    return reply.send({ categories: await getCategories() });
  });

  app.post('/api/geo/categories', auth, async (req, reply) => {
    const input = GeoCategoryInputSchema.parse(req.body);
    try {
      return reply.code(201).send(await addCategory(input));
    } catch (err) {
      if (err instanceof GeoCategoryNameConflict) {
        return reply.code(409).send({ error: 'NAME_CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  app.patch('/api/geo/categories/:id', auth, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const patch = GeoCategoryUpdateSchema.parse(req.body);
    let updated;
    try {
      updated = await updateCategory(id, patch);
    } catch (err) {
      if (err instanceof GeoCategoryNameConflict) {
        return reply.code(409).send({ error: 'NAME_CONFLICT', message: err.message });
      }
      throw err;
    }
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.send(updated);
  });

  app.delete('/api/geo/categories/:id', auth, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ok = await deleteCategory(id);
    if (!ok) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(204).send();
  });

  // ───── build + serve artifacts ─────
  // Building fetches every source .dat, so it is explicit. POST rebuilds and
  // returns metadata (categories, sha256s, per-source errors); GET returns the
  // last build's metadata (null until first built).
  app.post('/api/geo/build', auth, async (_req, reply) => {
    try {
      return reply.send(await rebuildGeo());
    } catch (err) {
      // Every source failed (nothing cached). Surface it as an error the UI
      // shows, but keep the per-source diagnostics (which upstream failed and
      // why) so the operator can act - a bare 500 would lose them.
      if (err instanceof GeoBuildAllSourcesFailed) {
        return reply.code(502).send({
          error: 'ALL_SOURCES_FAILED',
          message: 'every configured geo source failed to fetch',
          sourceErrors: err.meta.sourceErrors,
        });
      }
      throw err;
    }
  });

  app.get('/api/geo/build', auth, async (_req, reply) => {
    return reply.send(getGeoBuildMeta());
  });

  // Serve a built artifact by name (custom .dat + the full source mirror).
  async function serveArtifact(reply: FastifyReply, name: string): Promise<FastifyReply> {
    const artifact = await getGeoArtifact(name);
    if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Zero-copy view over the cached (immutable) bytes, not Buffer.from(...) which
    // copies the whole artifact per request - a mirror .dat is tens of MB, so N
    // slow-read clients would otherwise pin N full copies in memory.
    const body = Buffer.from(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength);
    return reply
      .type('application/octet-stream')
      .header('ETag', `"${artifact.sha256}"`)
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(body);
  }

  // Admin download (verify / inspect). ETag = sha256.
  app.get('/api/geo/artifacts/:name', auth, async (req, reply) => {
    const { name } = z.object({ name: ArtifactName }).parse(req.params);
    return serveArtifact(reply, name);
  });

  // G6 - PUBLIC distribution. Nodes fetch the mirror + custom .dat here; clients
  // fetch geo databases referenced by their subscription. Unauthenticated (geo
  // data is public; the threat is scanners/DDoS, not leakage - mitigated by the
  // capability prefix + reverse-proxy cache, per geo-svc). The prefix is a
  // deterministic token; a wrong one is a 404 (no oracle).
  // Constant-time capability check (hash both sides to a fixed length first,
  // since timingSafeEqual needs equal-sized inputs).
  const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
  app.get('/geo/:token/:name', async (req, reply) => {
    const parsed = z.object({ token: z.string(), name: ArtifactName }).safeParse(req.params);
    if (!parsed.success || !timingSafeEqual(digest(parsed.data.token), digest(geoArtifactToken()))) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    return serveArtifact(reply, parsed.data.name);
  });
}
