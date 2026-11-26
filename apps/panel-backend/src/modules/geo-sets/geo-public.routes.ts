import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { GEO_ASSET_NAME } from '@iceslab/shared';
import { isGeoArtifactToken } from './geo-public-url.js';
import { geoPublicBytes } from './geo-public-cache.js';
import { nodeFileName } from './geo-names.js';

/**
 * GET /geo/:token/:name (milestone 10.4): the geo files of the panel, served to
 * CLIENTS from its own domain, for networks where GitHub and the CDNs are slow
 * or blocked. Under GEO_SELF_HOST only; off, the address is a 404 like any
 * other the panel does not know.
 *
 * The files are what a node is sent: each set's CURRENT verified version, by
 * the names nodeFileName gives them (`geosite.dat`, `geoip.dat`, an operator's
 * or a composite set as `iceslab-<name>.dat`). A set with no verified version,
 * or whose last attempt is broken, is not served. All the sets are, by decision:
 * the token reaches every subscriber, so what it opens is not secret.
 *
 * The token is the credential and is one for the whole panel
 * (geo-public-url.ts). A wrong token, an unknown name and a set that is not
 * served all answer the same 404 (NOT_FOUND), so nothing tells them apart. The parameter is
 * called `token` so the request log masks it (log-redact.ts, by route spelling).
 */
const ServedName = z
  .string()
  .max(64)
  .regex(GEO_ASSET_NAME)
  // The `.json` rule-sets of GEO_ASSET_NAME are the chain's, laid out on a node.
  .refine((n) => n.endsWith('.dat'));

export async function geoPublicRoutes(app: FastifyInstance): Promise<void> {
  // Its own scope for the one thing: whatever else is asked under /geo/ (no
  // token, no name, a path that does not parse) gets the same answer as a
  // route's miss, not the panel's default 404 that echoes the URL. Only with
  // the flag on; off, /geo/ is as unknown as any other path.
  await app.register(geoPublicScope, { prefix: '/geo' });
}

async function geoPublicScope(app: FastifyInstance): Promise<void> {
  if (config.GEO_SELF_HOST) app.setNotFoundHandler((_req, reply) => notServed(reply));
  app.get<{ Params: { token: string; name: string } }>(
    '/:token/:name',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_GEO_PER_MIN, timeWindow: '1 minute' },
        // Tens of megabytes of .dat, which the global compressor would
        // otherwise be asked about; not compressed (the answer to a client that
        // may not take Content-Encoding for a .dat is simply not to use it).
        compress: false,
      },
    },
    async (req, reply) => {
      if (!config.GEO_SELF_HOST) return reply.callNotFound();
      const name = ServedName.safeParse(req.params.name);
      // Both checks always run, whichever fails first.
      const tokenOk = isGeoArtifactToken(req.params.token);
      if (!name.success || !tokenOk) return notServed(reply);

      const setName = name.data === 'geosite.dat' ? 'geosite' : name.data === 'geoip.dat' ? 'geoip' : /^iceslab-(.+)\.dat$/.exec(name.data)![1]!;
      const set = await prisma.geoSet.findUnique({
        where: { name: setName },
        select: { name: true, sourceType: true, status: true, current: { select: { sha256: true, sizeBytes: true } } },
      });
      // nodeFileName again: `iceslab-geosite.dat` is not the built-in's name.
      if (!set?.current || set.status === 'broken' || nodeFileName(set) !== name.data) return notServed(reply);

      const etag = `"${set.current.sha256}"`;
      reply
        .header('ETag', etag)
        // Always asked again, which costs a 304; the file under a name moves
        // when the set is refreshed or a rollout is made.
        .header('Cache-Control', 'public, no-cache')
        .header('X-Content-Type-Options', 'nosniff');
      if (matchesEtag(req.headers['if-none-match'], etag)) return reply.code(304).send();

      const data = await geoPublicBytes(set.current.sha256);
      if (!data) return notServed(reply);
      return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', data.length).send(data);
    },
  );
}

/** The one answer to everything that is not served: no body tells a wrong token from a missing file. */
function notServed(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'NOT_FOUND' });
}

/** `If-None-Match` as RFC 9110 section 13.1.2 reads it: `*` or a list, weak tags compared weakly. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}
