import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_ARCHES, CORE_BINARIES, type CoreArch, type CoreName } from '@iceslab/shared';
import { config } from '../../config.js';
import { verifyAgentBearer } from '../nodes/agent-auth.js';

/**
 * Where a node gets its proxy core.
 *
 * Before this, it got it from GitHub: "latest" resolved through
 * api.github.com and installed unverified, on the machine that holds the
 * node's mTLS key, over a path a node behind a censoring ISP may not have.
 * Now it asks the panel it already trusts, with the bearer its bootstrap
 * payload already carries — the same token the heartbeat uses, so no new
 * credential and no new trust.
 *
 * The panel serves what its image was BUILT with: the artefacts are downloaded
 * and checksum-verified at build time (see the Dockerfile and
 * packages/shared/src/core-binaries.ts) and are byte-identical to what upstream
 * published. `X-Iceslab-Sha256` carries the pinned sum so the node can verify
 * what it received without a second request.
 *
 * sing-box is the exception, and the header is why it needs one: the image
 * COMPILES it (upstream's binaries carry no `with_v2ray_api`, without which
 * sing-box refuses to start on the config this panel writes), so there is no
 * published sum to state. The build writes the sum of what it produced into a
 * `.sha256` sidecar and this route states THAT. The node's side of the deal is
 * untouched - it still compares the bytes it received against the sum the panel
 * named - and the pin that fails a build early moved to the source tarball.
 *
 * An architecture this image does not carry is a 404 that SAYS SO. The node
 * installer stops there rather than falling back to GitHub, which is the whole
 * point of the move: a fleet where some nodes quietly got their binaries from
 * somewhere else is the state this replaces.
 */
export async function coreRoutes(app: FastifyInstance): Promise<void> {
  const dir = config.CORES_DIR;

  /**
   * Both node-facing routes here, not just the one that hurts.
   *
   * The download hands back a file — ~21 MB for xray — so under the global
   * 100/min it costs the panel two gigabytes a minute per caller, and a valid
   * bearer is not a scarce thing: every node in the fleet holds one, and a
   * leaked one stays valid until the node is deleted. The listing is cheap by
   * comparison, but it does the same per-request bearer verification (a DB
   * roundtrip) and is asked by the same caller in the same install, so it gets
   * the same ceiling rather than being the next route in this family whose
   * guard someone has to notice is missing.
   */
  const rateLimit = { max: config.RATE_LIMIT_CORE_PER_MIN, timeWindow: '1 minute' };

  /** The pinned artefact for a (name, arch), or null when the pair is unknown. */
  function pinned(name: string, arch: string) {
    if (!(name in CORE_BINARIES)) return null;
    if (!CORE_ARCHES.includes(arch as CoreArch)) return null;
    const core = CORE_BINARIES[name as CoreName];
    const asset = (
      core.assets as Record<string, { file: string; sha256: string | null } | undefined>
    )[arch];
    return asset ? { core, asset } : null;
  }

  /**
   * The sum to state for a (name, arch): the manifest pin for a downloaded
   * core, the build's own sidecar for a compiled one.
   *
   * A compiled core with no sidecar is a 500, not a header left off. The node
   * refuses to install bytes the panel did not vouch for - by design - so the
   * failure has to name itself here rather than arrive there as a missing
   * header the operator has to trace back across two machines.
   */
  async function sha256For(name: string, arch: string, manifestSum: string | null) {
    if (manifestSum) return manifestSum;
    const sidecar = join(dir, `${name}-${arch}.sha256`);
    const sum = (await readFile(sidecar, 'utf8').catch(() => '')).trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/.test(sum ?? '') ? (sum as string) : null;
  }

  /**
   * What this panel can hand out. The installer reads it to fail EARLY and by
   * name — "this panel carries no hysteria for armv7" is an answer an operator
   * can act on, and it beats a download that 404s three steps later.
   */
  app.get('/api/internal/cores', { config: { rateLimit } }, async (request, reply) => {
    if (!(await verifyAgentBearer(request))) {
      return reply.code(401).send({ error: 'INVALID_TOKEN' });
    }
    const cores = [];
    for (const [name, core] of Object.entries(CORE_BINARIES)) {
      for (const arch of CORE_ARCHES) {
        const hit = pinned(name, arch);
        if (!hit) continue;
        // `carried` is asked of the DISK, not of the manifest: the image is
        // built with a CORE_ARCHES subset, so the manifest knowing about an
        // architecture does not mean this panel has it.
        const carried = await stat(join(dir, `${name}-${arch}`))
          .then((s) => s.isFile())
          .catch(() => false);
        cores.push({
          name,
          arch,
          version: core.version,
          sha256: await sha256For(name, arch, hit.asset.sha256),
          file: hit.asset.file,
          carried,
        });
      }
    }
    return reply.send({ cores });
  });

  app.get<{ Params: { name: string; arch: string } }>(
    '/api/internal/cores/:name/:arch',
    { config: { rateLimit } },
    async (request, reply) => {
      if (!(await verifyAgentBearer(request))) {
        return reply.code(401).send({ error: 'INVALID_TOKEN' });
      }
      const { name, arch } = request.params;
      const hit = pinned(name, arch);
      if (!hit) {
        return reply
          .code(404)
          .send({ error: 'UNKNOWN_CORE', message: `no pin for ${name}/${arch}` });
      }
      // Built from the validated pair, never from the raw params: `name` and
      // `arch` reach a filesystem path, and the only reason `../` cannot get
      // through is that both were matched against fixed lists above.
      const path = join(dir, `${name}-${arch}`);
      const size = await stat(path)
        .then((s) => (s.isFile() ? s.size : null))
        .catch(() => null);
      if (size === null) {
        return reply.code(404).send({
          error: 'NOT_CARRIED',
          message:
            `this panel carries no ${name} for ${arch}. Rebuild the panel image ` +
            `with CORE_ARCHES including ${arch}, or install that node on an ` +
            `architecture the panel carries.`,
        });
      }
      const sum = await sha256For(name, arch, hit.asset.sha256);
      if (!sum) {
        return reply.code(500).send({
          error: 'UNVERIFIABLE_CORE',
          message:
            `this panel carries ${name} for ${arch} but cannot state its sha256: ` +
            `${name}-${arch}.sha256 is missing or malformed. It is written beside ` +
            `the binary when the image compiles a core; rebuild the panel image.`,
        });
      }
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(size))
        .header('x-iceslab-sha256', sum)
        .header('x-iceslab-core-version', hit.core.version)
        .send(createReadStream(path));
    },
  );
}
