import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CORE_BINARIES, ENGINE_CORE, PROTOCOL_CORE } from '@iceslab/shared';
import { requireAuth } from '../auth/auth.hook.js';
import { acmeHostnameFor } from '../inbounds/inbounds.queue.js';
import { config } from '../../config.js';
import {
  CreateNodeSchema,
  UpdateNodeSchema,
  ListNodesQuerySchema,
  NodeIdParamSchema,
  type HardeningFlags,
} from './nodes.schemas.js';
import * as nodesService from './nodes.service.js';
import { egressCatalogue } from '../egress/egress.catalogue.js';
import { appendHardeningFlags, appendSingboxFlag } from './nodes.service.js';
import { checkNodePortExposure } from './nodes.exposure.js';
import * as bootstrap from './bootstrap.service.js';
import { getPanelPublicIp } from './panel-ip.js';
import * as nodesRepo from './nodes.repository.js';
import { NodeTransport } from './nodes.transport.js';

/**
 * Derive the panel URL the admin is currently using to talk to the API.
 * Prefers PUBLIC_URL env var (set in docker-compose) over request-derived
 * heuristics, the heuristic breaks when Caddy doesn't forward X-Forwarded-Proto.
 */
function publicUrlFromRequest(request: FastifyRequest): string {
  if (config.PUBLIC_URL) return config.PUBLIC_URL.replace(/\/$/, '');
  const xfHost = request.headers['x-forwarded-host']?.toString();
  const proto =
    request.headers['x-forwarded-proto']?.toString() ||
    (xfHost ? 'https' : (request as unknown as { protocol?: string }).protocol) ||
    'http';
  const host = xfHost || request.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

const BootstrapTokenParam = z.object({ token: z.string().regex(/^bs_[A-Za-z0-9_-]+$/).max(64) });
const auth = { onRequest: [requireAuth] };

// Mirror of nodes.service.ts:renderBootstrapCommand, kept here because the
// /api/nodes/:id/bootstrap endpoint generates the command without going
// through the service path. Should produce byte-identical output.
async function renderRefreshBootstrapCommand(
  panelUrl: string,
  token: string,
  protocol: string,
  nodeAddress: string,
  hardening?: HardeningFlags | null,
  singboxEngine?: boolean,
): Promise<string> {
  const panelIp = await getPanelPublicIp();
  const lines = [
    'bash <(curl -fsSL https://raw.githubusercontent.com/icecompany-tech/iceslab/main/scripts/install-iceslab-node.sh) \\',
    `  --panel-url ${panelUrl} \\`,
    `  --bootstrap ${token} \\`,
    `  --protocol ${protocol} \\`,
  ];
  if (panelIp) {
    lines.push(`  --panel-ip ${panelIp}`);
  } else {
    lines.push('  --panel-ip YOUR_PANEL_PUBLIC_IP  # auto-detect failed, replace with panel IP');
  }
  // The name the command carries has to be one a public CA can issue for, and
  // `acmeHostnameFor` is where that rule already lives — it returns null for an
  // IP literal and for a single-label name, with the reason spelled out. This
  // renderer used `address.split(':')[0]` instead, so a node registered by IP
  // (which is every node before somebody points DNS at it) got
  // `--hysteria-domain <the IP>`. Measured on a real node from this very
  // command: hysteria wrote `acme.domains: [127.0.0.1]`, exited with "subject
  // '127.0.0.1' does not qualify for a public certificate", and never served
  // anything — while the installer printed its success banner, because its last
  // step asks about the agent.
  //
  // Two renderers, one guard: this one and renderBootstrapCommand in
  // nodes.service.ts.
  const acmeDomain = acmeHostnameFor(nodeAddress);
  const acmeEmail = (process.env.ACME_DEFAULT_EMAIL ?? '').trim();
  if (protocol === 'hysteria' && acmeDomain) {
    lines[lines.length - 1] += ' \\';
    lines.push(`  --hysteria-domain ${acmeDomain} \\`);
    lines.push(
      acmeEmail
        ? `  --hysteria-email ${acmeEmail}`
        : '  --hysteria-email admin@example.com  # set ACME_DEFAULT_EMAIL env to inject automatically',
    );
  } else if (protocol === 'hysteria') {
    // Say it in the command, where the operator is looking. Silence here reads
    // as "nothing else to do", and hysteria would simply never come up.
    lines.push(
      `  # hysteria needs a public FQDN for its certificate, and ${nodeAddress.split(':')[0]} is not one.`,
    );
    lines.push('  # Point a name at this node, set it as the node address, and re-issue this command.');
  }
  // Naive / SS2022 / MTProto / Mieru: no install-time flags. Profile-side
  // config flows over mTLS from panel via applyInbound after bootstrap.

  // G - node hardening flags. Shared helper keeps this byte-identical with
  // renderBootstrapCommand in nodes.service.ts.
  appendHardeningFlags(lines, hardening);
  appendSingboxFlag(lines, singboxEngine, protocol);

  return lines.join('\n');
}

export async function nodesRoutes(app: FastifyInstance): Promise<void> {
  // Public bootstrap-redeem route: the token IS the credential (single-use,
  // 15-min TTL). Per-route auth opt-in pattern matches auth.routes.ts and
  // avoids the addHook scope ambiguity that previously made this 401.
  app.get('/api/internal/bootstrap/:token', {
    config: {
      // Token is a one-shot 192-bit secret, but we still don't want to be
      // a guessing oracle. 10 attempts/min/IP is enough for the legitimate
      // single redeem and slow enough that brute-forcing within the 15-min
      // TTL is infeasible.
      rateLimit: {
        max: config.RATE_LIMIT_BOOTSTRAP_PER_MIN,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const params = BootstrapTokenParam.parse(request.params);
    try {
      const payload = await bootstrap.redeemBootstrapToken(params.token);
      return reply.type('text/plain').send(payload);
    } catch (err) {
      if (err instanceof bootstrap.BootstrapTokenError) {
        return reply.code(err.httpStatus).send({
          error: err.reason,
          message: err.message,
        });
      }
      throw err;
    }
  });

  // Slice 38: heartbeat self-destruct. Public-but-Bearer-authed; the
  // bearer is an HMAC the agent received in its bootstrap payload.
  await app.register(
    async (s) => {
      const { heartbeatRoutes } = await import('./heartbeat.routes.js');
      await heartbeatRoutes(s);
    },
    { prefix: '/api/internal/nodes' },
  );

  app.post('/api/nodes', auth, async (request, reply) => {
    const input = CreateNodeSchema.parse(request.body);
    try {
      const node = await nodesService.createNode(input, {
        panelUrl: publicUrlFromRequest(request),
      });
      return reply.code(201).send(node);
    } catch (err) {
      if (err instanceof nodesService.NodeAlreadyExistsError) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  app.post('/api/nodes/:id/bootstrap', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    try {
      const node = await nodesService.getNodeById(params.id);
      const tokenInfo = await bootstrap.issueBootstrapToken(node.id);
      return reply.code(201).send({
        token: tokenInfo.token,
        expiresAt: tokenInfo.expiresAt.toISOString(),
        command: await renderRefreshBootstrapCommand(
          publicUrlFromRequest(request),
          tokenInfo.token,
          node.protocol,
          node.address,
          node.hardening,
          node.singboxEngine,
        ),
      });
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // WARP egress (feat/warp-native): register a free Cloudflare WARP device for
  // this node and enable per-node egress. The Cloudflare call lives in the warp
  // service; this is the live path of the registration spike.
  app.post('/api/nodes/:id/warp/register', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    try {
      return reply.send(await nodesService.registerNodeWarp(params.id));
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // Turn off WARP egress (keeps the registered creds for instant re-enable).
  app.delete('/api/nodes/:id/warp', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    try {
      return reply.send(await nodesService.disableNodeWarp(params.id));
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  /**
   * B2b - which DPI-bypass strategies have actually worked, grouped by the AS
   * they worked on. Read-only: it is the fleet's own self-tune reports, not a
   * curated list, so it says what was measured and leaves adopting one to the
   * operator.
   *
   * A static path, so it is declared before /api/nodes/:id below.
   */
  app.get('/api/nodes/egress-catalogue', auth, async (_request, reply) => {
    return reply.send({ groups: await egressCatalogue() });
  });

  app.get('/api/nodes', auth, async (request, reply) => {
    const query = ListNodesQuerySchema.parse(request.query);
    return reply.send(await nodesService.listNodes(query));
  });

  app.get('/api/nodes/:id', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    try {
      return reply.send(await nodesService.getNodeById(params.id));
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });

  // G4 probe-exposure: compare the node's open ufw ports to the expected set.
  // Advisory + best-effort (an old/unreachable agent or ufw-less host returns
  // checked:false), so it never throws a 4xx/5xx for a reachable request.
  app.get('/api/nodes/:id/exposure', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    return reply.send(await checkNodePortExposure(params.id));
  });

  /**
   * What this node's cores actually run, against what the panel pinned.
   *
   * Asked LIVE rather than read from a column, and that is the honest shape:
   * the panel persists ONE core version per node (`nodes.core_version`, xray's,
   * because until 2026-08-28 xray was the only adapter that reported one).
   * Storing a version per core is a schema change and has not been done — the
   * same note `coreRestarts` carries about holding a single object.
   *
   * So this is a probe, and it says so: an unreachable node answers with the
   * reason instead of a stale table an operator would read as current.
   */
  app.get('/api/nodes/:id/cores', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    const node = await nodesRepo.findActiveById(params.id);
    if (!node) return reply.code(404).send({ error: 'NOT_FOUND' });

    let health;
    try {
      health = await new NodeTransport(node).healthcheck();
    } catch (err) {
      // A node that cannot be reached is not a node running nothing, and the
      // difference is the whole reason to name it here.
      return reply.send({
        reachable: false,
        reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        cores: [],
      });
    }

    const cores = health.cores.map((core) => {
      // Which artefact to compare against is decided by the ENGINE the node
      // says is serving this protocol, not by the protocol's native core. A
      // node with sing-box installed registers an adapter per protocol — xray
      // and hysteria among them — all of them rendered by sing-box, and
      // pinning them to xray's and hysteria's versions reported drift on a
      // node that is fine. Which is exactly what the `drift` comment below
      // says must not happen.
      //
      // `engine` is absent on an agent older than the field; falling back to
      // PROTOCOL_CORE keeps that node reading the way it did before.
      const pinnedName = (core.engine ? ENGINE_CORE[core.engine] : undefined)
        ?? PROTOCOL_CORE[core.name]
        ?? null;
      const pinned = pinnedName ? CORE_BINARIES[pinnedName].version : null;
      return {
        protocol: core.name,
        /** The artefact behind it, e.g. tuic -> sing-box. Null when the panel
         *  pins none: amneziawg, wireguard and naive are built or come from
         *  apt. */
        core: pinnedName,
        /** What the node said renders it, verbatim. Two rows with the same
         *  protocol and different engines are two adapters, and an operator
         *  reading "xray, sing-box" should see that rather than infer it. */
        engine: core.engine ?? null,
        running: core.running,
        // Absent means "the agent predates the field", which is not false.
        provisioned: core.provisioned ?? null,
        /** Empty when the adapter cannot report one — a pre-2026-08 agent, or
         *  a core with no binary of its own. */
        version: core.version || null,
        pinned,
        /** Only ever true when BOTH numbers are known. An unknown version is a
         *  question, not a mismatch, and showing it as drift would send an
         *  operator to fix a node that is fine. */
        drift: Boolean(core.version && pinned && core.version !== pinned),
      };
    });
    return reply.send({ reachable: true, cores });
  });

  app.put('/api/nodes/:id', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    const input = UpdateNodeSchema.parse(request.body);
    try {
      return reply.send(await nodesService.updateNode(params.id, input));
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      if (err instanceof nodesService.NodeAlreadyExistsError) {
        return reply.code(409).send({ error: 'CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  app.delete('/api/nodes/:id', auth, async (request, reply) => {
    const params = NodeIdParamSchema.parse(request.params);
    try {
      await nodesService.deleteNode(params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof nodesService.NodeNotFoundError) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: err.message });
      }
      throw err;
    }
  });
}
