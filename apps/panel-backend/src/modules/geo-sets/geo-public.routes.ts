import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { GEO_ASSET_NAME, GEO_SRS_NAME } from '@iceslab/shared';
import { isGeoArtifactToken } from './geo-public-url.js';
import { geoPublicBytes } from './geo-public-cache.js';
import { nodeFileName, srsFileName } from './geo-names.js';
import { servedSet } from './geo-self-host.js';
import { geoSrsBytes } from './geo-srs-cache.js';
import { GeoTagUnknownError } from './geo-dat.js';
import { SingboxMissingError, SrsCompileError } from './geo-srs.js';
import { singboxAvailable } from '../../lib/util/singbox-bin.js';

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
 * Milestone 10.5 adds the sing-box rule-sets: `<kind>-<tag>.srs` for a built-in
 * set, `iceslab-<set>.<tag>.srs` for any other (GEO_SRS_NAME), the `.srs` of one
 * tag of the set's current version, compiled on the first request and kept
 * (geo-srs-cache.ts). A tag the version lacks, or no sing-box on the panel, is
 * the same 404.
 *
 * The token is the credential and is one for the whole panel
 * (geo-public-url.ts). A wrong token, an unknown name and a set that is not
 * served all answer the same 404 (NOT_FOUND), so nothing tells them apart. The parameter is
 * called `token` so the request log masks it (log-redact.ts, by route spelling).
 */
const ServedName = z
  .string()
  .max(64)
  // The `.json` rule-sets of GEO_ASSET_NAME are the chain's, laid out on a node.
  .refine((n) => (GEO_ASSET_NAME.test(n) && n.endsWith('.dat')) || GEO_SRS_NAME.test(n));

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

      if (name.data.endsWith('.srs')) return serveSrs(req.headers['if-none-match'], name.data, reply);

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

/** One tag of one set as a compiled sing-box rule-set. */
async function serveSrs(ifNoneMatch: string | undefined, file: string, reply: FastifyReply): Promise<FastifyReply> {
  const m = GEO_SRS_NAME.exec(file)!;
  const setName = m[1] ?? m[3]!;
  const tag = m[2] ?? m[4]!;
  if (!singboxAvailable()) return notServed(reply);
  const set = await servedSet(setName);
  // The name has to be the one the set is served under: `iceslab-geosite.x.srs` is not the built-in's.
  if (!set || srsFileName(set, tag) !== file) return notServed(reply);
  // Attributes and the complement are the rule's spelling of a tag the set has.
  if (!set.tags.has(tag.replace(/^!/, '').split('@')[0]!)) return notServed(reply);

  // Of the version and the tag, so a 304 costs no compilation.
  const etag = `"${createHash('sha256').update(`srs\0${set.sha256}\0${tag}`).digest('hex')}"`;
  reply
    .header('ETag', etag)
    .header('Cache-Control', 'public, no-cache')
    .header('X-Content-Type-Options', 'nosniff');
  if (matchesEtag(ifNoneMatch, etag)) return reply.code(304).send();
  try {
    const data = await geoSrsBytes(set.sha256, set.kind === 'geoip' ? 'geoip' : 'geosite', tag);
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', data.length).send(data);
  } catch (err) {
    if (err instanceof GeoTagUnknownError || err instanceof SingboxMissingError) return notServed(reply);
    reply.log.warn({ err: err instanceof SrsCompileError ? err.message : err, file }, 'geo: .srs not compiled');
    return reply.removeHeader('ETag').removeHeader('Cache-Control').code(503).send({ error: 'GEO_SRS_UNAVAILABLE' });
  }
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
