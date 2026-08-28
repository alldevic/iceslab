import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
import { geoCategoryUsage, nodesUsingGeoCategory } from '../cascades/cascade.service.js';
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
  getBuiltGeoArtifact,
  getGeoBuildMeta,
  isGeoBuildReady,
  startGeoBuild,
  GeoBuildAllSourcesFailed,
} from './geo.registry.js';
import { rebuildGeoAndRepush } from './geo.cron.js';
import { geoArtifactToken } from './geo.url.js';

// Servable artifact names (custom .dat / mirror .dat / per-category .srs). The
// registry only returns names it actually built, so this just bounds the shape.
// Fits the longest generated name: `custom-<category>.srs` where a category is
// up to 80 chars (see geo.schemas category name), so 7 + 80 + 4 = 91.
const ArtifactName = z.string().regex(/^[A-Za-z0-9._-]+$/).max(96);

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

  // Where each custom category is routed by, for the whole list at once. Static
  // path, so it is declared before the `:id` routes and never eaten by them.
  //
  // The delete below refuses while a category is in use; this is the same answer
  // offered BEFORE the operator reaches for delete, because "you cannot do that"
  // is a worse way to learn where something is used than simply being told.
  app.get('/api/geo/categories/usage', auth, async (_req, reply) => {
    return reply.send({ usage: await geoCategoryUsage() });
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
    // Refuse while a cascade still routes by it. Deleting anyway is not an error
    // anyone sees: the unsatisfiable ext: matcher is stripped at render (it must
    // be, xray refuses a config naming a .dat it cannot find), so the split
    // silently stops splitting on a screen nobody is looking at.
    const cat = (await getCategories()).find((c) => c.id === id);
    if (cat) {
      const used = await nodesUsingGeoCategory(cat.name);
      if (used.length > 0) {
        return reply.code(409).send({
          error: 'CATEGORY_IN_USE',
          message: `"${cat.name}" is used by a geo split in: ${used.join(', ')}. Remove those rules first.`,
          cascades: used,
        });
      }
    }
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
      // Rebuild AND propagate: when the rebuild changes a custom .dat, re-push the
      // egress-policy cascades so the change reaches the entry nodes (the rebuild
      // alone only refreshes the panel-served artifacts, not the fleet).
      return reply.send(await rebuildGeoAndRepush({ forceRepush: false }));
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

  // A geo artifact is content-addressed: its ETag is the sha256 of the bytes, so
  // any content change necessarily mints a new ETag. That lets a client cache the
  // body for a good while and revalidate cheaply - it re-requests with
  // If-None-Match and we answer 304 (no body) when the build hasn't changed,
  // instead of re-streaming tens of MB. A raised max-age (vs the old 300s) cuts
  // the request rate itself; ETag revalidation bounds staleness after it lapses.
  const GEO_CACHE_CONTROL = 'public, max-age=3600';

  /** Serve a built artifact by name (custom .dat + the full source mirror). */
  function respond(
    req: FastifyRequest,
    reply: FastifyReply,
    name: string,
    artifact: { sha256: string; bytes: Uint8Array } | null,
  ): FastifyReply {
    if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND' });
    const etag = `"${artifact.sha256}"`;
    // Conditional GET: if the client already holds this exact build, answer 304.
    // `If-None-Match` may carry a comma-list and/or a weak `W/` prefix; the sha is
    // unique, so a substring test on the strong tag is enough and prefix-safe.
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.includes(artifact.sha256)) {
      return reply.code(304).header('ETag', etag).header('Cache-Control', GEO_CACHE_CONTROL).send();
    }
    // Zero-copy view over the cached (immutable) bytes, not Buffer.from(...) which
    // copies the whole artifact per request - a mirror .dat is tens of MB, so N
    // slow-read clients would otherwise pin N full copies in memory.
    const body = Buffer.from(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength);
    return reply
      .type('application/octet-stream')
      .header('ETag', etag)
      .header('Cache-Control', GEO_CACHE_CONTROL)
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(body);
  }

  // Admin download (verify / inspect). ETag = sha256. This one DOES wait for a
  // cold build: the caller is a person who clicked Download and expects the
  // file, not a fetcher with a stall timer.
  app.get('/api/geo/artifacts/:name', auth, async (req, reply) => {
    const { name } = z.object({ name: ArtifactName }).parse(req.params);
    return respond(req, reply, name, await getGeoArtifact(name));
  });

  // G6 - PUBLIC distribution. Nodes fetch the mirror + custom .dat here; clients
  // fetch geo databases referenced by their subscription. Unauthenticated (geo
  // data is public; the threat is scanners/DDoS, not leakage). The prefix is a
  // deterministic token; a wrong one is a 404 (no oracle).
  //
  // The second half of that mitigation - a reverse-proxy cache in front - does
  // NOT exist in the bundled deploy: it is deferred in
  // docs/geo-svc-prod-checklist.md until the client base grows. So today the
  // only ceiling on this route is the app-wide 100/min/IP, and one answer is
  // the whole source mirror (73 703 302 bytes on the 2026-08-29 lab build).
  //
  // Both halves of that measured on 2026-08-29 rather than reasoned about: 130
  // requests in a row answered 79 x 200 and 51 x 429, so the global limiter
  // does cover this route; and a warm body leaves in 14 ms over loopback, so
  // the panel is not the bottleneck, the link is. The ceiling is therefore
  // exactly 100 x 70 MB = about 7 GB/min from one address.
  //
  // No per-route rate limit is written here on purpose: a number low enough to
  // bound that egress is also low enough to cut off a CGNAT of real clients the
  // hour after a rebuild, so the cache is the fix and this comment is the
  // record that it is still owed.
  // Constant-time capability check (hash both sides to a fixed length first,
  // since timingSafeEqual needs equal-sized inputs).
  const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
  app.get('/geo/:token/:name', async (req, reply) => {
    const parsed = z.object({ token: z.string(), name: ArtifactName }).safeParse(req.params);
    if (!parsed.success || !timingSafeEqual(digest(parsed.data.token), digest(geoArtifactToken()))) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    // Never block a fetcher on a build. A cold build is 34 s of complete
    // silence (measured), the node cancels an attempt after 30 s with nothing
    // arriving, and it holds the adapter's restart lock while it waits - so
    // waiting here costs that node every config apply and every live user
    // update for ~93 s and still ends in failure. Answer "not yet, ask again",
    // which its fetcher retries as a transient (>= 500), and start the build
    // the next ask will be served from.
    if (!isGeoBuildReady()) {
      startGeoBuild((err) => req.log.warn({ err }, 'geo lazy build failed'));
      return reply
        .code(503)
        .header('Retry-After', '60')
        .header('Cache-Control', 'no-store')
        .send({ error: 'NOT_BUILT', message: 'geo build not ready yet, retry shortly' });
    }
    return respond(req, reply, parsed.data.name, getBuiltGeoArtifact(parsed.data.name));
  });
}
