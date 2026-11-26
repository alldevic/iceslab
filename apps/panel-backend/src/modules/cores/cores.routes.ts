import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CORE_ARCHES,
  CORE_COMPONENTS,
  CORE_SCRIPTS,
  CORE_SCRIPT_NAMES,
  CORE_VERSIONS,
  coreArtifactName,
  coreArtifacts,
  coreScriptName,
  type CoreArch,
  type CoreComponent,
  type CoreScriptName,
} from '@iceslab/shared';
import { config } from '../../config.js';
import { prisma } from '../../prisma.js';
import { verifyAgentBearer } from '../nodes/agent-auth.js';

/**
 * Where a node gets its cores from: the panel image it already trusts, with the
 * bearer its bootstrap payload already carries (the heartbeat's), so no new
 * credential.
 *
 *   GET /api/internal/cores                                  what the manifest lists, and what is on disk
 *   GET /api/internal/cores/:component/:version/:arch        one artifact
 *   GET /api/internal/cores/scripts/:name/:ref               a pinned script (xray's install-release.sh)
 *
 * The files were downloaded and checked against the manifest's sha256 when the
 * image was built (Dockerfile `cores` stage), so `x-iceslab-sha256` is the
 * manifest's value and the node compares what it received against it. The
 * header is the manifest's claim, not a hash taken per request.
 *
 * Every path segment that reaches the filesystem is the manifest's own value,
 * found by matching the request's parameter against the manifest, never the
 * parameter itself: `..` and unknown names stop at the lookup.
 *
 * A node that was soft-deleted gets 410 GONE, as on the heartbeat. A disabled
 * node is served: an admin toggles that, and the node must still be able to
 * finish an install.
 */
export async function coresRoutes(app: FastifyInstance): Promise<void> {
  const dir = config.CORES_DIR;

  // Both kinds of route: the download is tens of MB per request, and a valid
  // bearer is not scarce (every node holds one; a leaked one lives until its
  // node is deleted). The listing does the same bearer check, a DB roundtrip.
  const rateLimit = { max: config.RATE_LIMIT_CORE_PER_MIN, timeWindow: '1 minute' };

  /** Sends the 401/410 itself; true when the caller may go on. */
  async function admit(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const verified = await verifyAgentBearer(request);
    if (!verified.ok) {
      await reply.code(401).send({ error: verified.error });
      return false;
    }
    const node = await prisma.node.findUnique({
      where: { id: verified.nodeId },
      select: { deletedAt: true },
    });
    // No row here is a delete racing this request; same answer as a deleted one.
    if (!node || node.deletedAt) {
      await reply.code(410).send({ error: 'GONE' });
      return false;
    }
    return true;
  }

  const sizeOf = (path: string) =>
    stat(path)
      .then((s) => (s.isFile() ? s.size : null))
      .catch(() => null);

  const notCarried = (what: string, arch: string) => ({
    error: 'NOT_CARRIED',
    message:
      `this panel carries no ${what} for ${arch}. Rebuild the panel image with ` +
      `CORE_ARCHES including ${arch}, or install that node on an architecture the panel carries.`,
  });

  async function send(reply: FastifyReply, path: string, sha256: string, version: string) {
    const size = await sizeOf(path);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(size))
      .header('x-iceslab-sha256', sha256)
      .header('x-iceslab-core-version', version)
      .send(createReadStream(path));
  }

  app.get('/api/internal/cores', { config: { rateLimit } }, async (request, reply) => {
    if (!(await admit(request, reply))) return reply;
    // `carried` is asked of the disk: the image is built with a subset of the
    // arches, so the manifest listing an artifact does not mean this panel has it.
    const cores = [];
    for (const a of coreArtifacts()) {
      cores.push({
        component: a.component,
        version: a.version,
        arch: a.arch,
        file: a.file,
        sha256: a.sha256,
        carried: (await sizeOf(join(dir, a.stored))) !== null,
      });
    }
    const scripts = [];
    for (const name of CORE_SCRIPT_NAMES) {
      const s = CORE_SCRIPTS[name];
      scripts.push({
        name,
        ref: s.ref,
        file: s.file,
        sha256: s.sha256,
        carried: (await sizeOf(join(dir, coreScriptName(name, s)))) !== null,
      });
    }
    return reply.send({ cores, scripts });
  });

  app.get<{ Params: { component: string; version: string; arch: string } }>(
    '/api/internal/cores/:component/:version/:arch',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!(await admit(request, reply))) return reply;
      const { component, version, arch } = request.params;
      const known = (CORE_COMPONENTS as readonly string[]).includes(component);
      const release = known
        ? CORE_VERSIONS[component as CoreComponent].releases.find((r) => r.version === version)
        : undefined;
      if (!release) {
        return reply
          .code(404)
          .send({ error: 'UNKNOWN_CORE', message: `no release ${component}/${version} in the manifest` });
      }
      const knownArch = (CORE_ARCHES as readonly string[]).includes(arch);
      const asset = knownArch ? release.assets?.[arch as CoreArch] : undefined;
      if (!asset) {
        return reply.code(404).send({
          error: 'UNKNOWN_CORE',
          message: `release ${component}/${version} has no artifact for ${arch}`,
        });
      }
      // From the manifest's values, not the parameters (see the header comment).
      const path = join(dir, coreArtifactName(component as CoreComponent, release.version, arch as CoreArch, asset.file));
      if ((await sizeOf(path)) === null) {
        return reply.code(404).send(notCarried(`${component} ${version}`, arch));
      }
      return send(reply, path, asset.sha256, release.version);
    },
  );

  app.get<{ Params: { name: string; ref: string } }>(
    '/api/internal/cores/scripts/:name/:ref',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!(await admit(request, reply))) return reply;
      const { name, ref } = request.params;
      const script = (CORE_SCRIPT_NAMES as readonly string[]).includes(name)
        ? CORE_SCRIPTS[name as CoreScriptName]
        : undefined;
      if (!script || script.ref !== ref) {
        return reply
          .code(404)
          .send({ error: 'UNKNOWN_CORE', message: `no script ${name}@${ref} in the manifest` });
      }
      const path = join(dir, coreScriptName(name as CoreScriptName, script));
      if ((await sizeOf(path)) === null) {
        return reply.code(404).send({
          error: 'NOT_CARRIED',
          message: `this panel image carries no ${name}; rebuild the panel image.`,
        });
      }
      return send(reply, path, script.sha256, script.ref);
    },
  );
}
