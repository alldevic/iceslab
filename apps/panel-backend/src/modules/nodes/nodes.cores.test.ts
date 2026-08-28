import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CORE_BINARIES } from '@iceslab/shared';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { NodeTransport } from './nodes.transport.js';

/**
 * "What does this node run, and is it what the panel pinned?"
 *
 * The reason this route exists at all: since the panel carries the core
 * artefacts, there are two versions in play — the one on the node and the one
 * the panel would install — and an operator has no way to compare them. The
 * answer is a LIVE probe, because the panel persists exactly one core version
 * per node (xray's, from the days when xray was the only adapter that reported
 * one) and a per-core column is a schema change that has not been made. A stale
 * table read as current is worse than a probe that says it could not reach.
 *
 * Every case here is about a DIFFERENCE that must not be flattened: unknown is
 * not mismatched, unreachable is not "runs nothing", and a protocol the panel
 * pins nothing for is not drift.
 */

let app: FastifyInstance;
let token: string;
let nodeId: string;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  const node = await prisma.node.create({
    data: {
      name: `cores-${Date.now()}`,
      address: 'cores.example.com:1337',
      heartbeatSecret: Buffer.alloc(32),
    },
  });
  nodeId = node.id;
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const ask = () =>
  app.inject({
    method: 'GET',
    url: `/api/nodes/${nodeId}/cores`,
    headers: { authorization: `Bearer ${token}` },
  });

/** Answer /healthz with these cores, without a node. */
function healthz(cores: unknown[]) {
  vi.spyOn(NodeTransport.prototype, 'healthcheck').mockResolvedValue({
    status: 'ok',
    cores,
  } as never);
}

describe('the two numbers, side by side', () => {
  it('reports no drift when the node runs what the panel pins', async () => {
    healthz([{ name: 'xray', running: true, version: CORE_BINARIES.xray.version }]);
    const body = (await ask()).json() as {
      reachable: boolean;
      cores: { protocol: string; core: string; version: string; pinned: string; drift: boolean }[];
    };
    expect(body.reachable).toBe(true);
    expect(body.cores).toHaveLength(1);
    expect(body.cores[0]).toMatchObject({
      protocol: 'xray',
      core: 'xray',
      version: CORE_BINARIES.xray.version,
      pinned: CORE_BINARIES.xray.version,
      drift: false,
    });
  });

  it('and reports drift when it does not', async () => {
    healthz([{ name: 'xray', running: true, version: '1.2.3' }]);
    const { cores } = (await ask()).json() as { cores: { drift: boolean; pinned: string }[] };
    expect(cores[0]!.drift).toBe(true);
    expect(cores[0]!.pinned).toBe(CORE_BINARIES.xray.version);
  });

  it('maps a protocol to the artefact behind it', async () => {
    // tuic, anytls and shadowtls are all sing-box; shadowsocks is xray. A node
    // running TUIC has no "tuic" binary to compare, and saying so wrongly would
    // be a version the operator cannot act on.
    healthz([
      { name: 'tuic', running: true, version: CORE_BINARIES['sing-box'].version },
      { name: 'shadowsocks', running: true, version: CORE_BINARIES.xray.version },
    ]);
    const { cores } = (await ask()).json() as { cores: { protocol: string; core: string; drift: boolean }[] };
    expect(cores.map((c) => `${c.protocol}->${c.core}`)).toEqual([
      'tuic->sing-box',
      'shadowsocks->xray',
    ]);
    expect(cores.every((c) => !c.drift)).toBe(true);
  });
});

describe('what must not be flattened', () => {
  it('an unknown version is a question, not a mismatch', async () => {
    // A pre-2026-08 agent reports no version at all. Showing that as drift
    // sends an operator to fix a node that may be perfectly current.
    healthz([{ name: 'xray', running: true }]);
    const { cores } = (await ask()).json() as { cores: { version: null; drift: boolean }[] };
    expect(cores[0]!.version).toBeNull();
    expect(cores[0]!.drift).toBe(false);
  });

  it('a protocol the panel pins nothing for is not drift either', async () => {
    // amneziawg drives the kernel module; there is no artefact to compare.
    healthz([{ name: 'amneziawg', running: true, version: '1.0.0' }]);
    const { cores } = (await ask()).json() as {
      cores: { core: null; pinned: null; drift: boolean }[];
    };
    expect(cores[0]!.core).toBeNull();
    expect(cores[0]!.pinned).toBeNull();
    expect(cores[0]!.drift).toBe(false);
  });

  it('an absent `provisioned` stays absent rather than becoming false', async () => {
    // The wire contract says so: absent means the agent predates the field,
    // and a panel reading that as "not configured" would call every older node
    // unconfigured.
    healthz([{ name: 'xray', running: true, version: '1.2.3' }]);
    const { cores } = (await ask()).json() as { cores: { provisioned: null }[] };
    expect(cores[0]!.provisioned).toBeNull();
  });

  it('an unreachable node says why, instead of reporting no cores', async () => {
    vi.spyOn(NodeTransport.prototype, 'healthcheck').mockRejectedValue(
      new Error('connect ECONNREFUSED 203.0.113.10:1337'),
    );
    const body = (await ask()).json() as { reachable: boolean; reason: string; cores: [] };
    expect(body.reachable).toBe(false);
    expect(body.reason).toContain('ECONNREFUSED');
    expect(body.cores).toEqual([]);
  });

  /**
   * The pin is chosen by the ENGINE the node names, not by the protocol.
   *
   * Measured on a real VM, 2026-08-28: a node installed with --protocol tuic
   * reported `xray running:false version:1.13.19 pinned:26.3.27 drift:true`.
   * Nothing was wrong with that node. The sing-box engine registers one
   * adapter per protocol it can render — xray and hysteria among them — so the
   * node truthfully reported a protocol called `xray` whose core is sing-box,
   * and the panel compared sing-box's version against xray's pin. The `drift`
   * field's own comment says an operator must not be sent to fix a node that
   * is fine, which is precisely what this did.
   */
  it('pins an xray-family protocol served by sing-box to sing-box, not to xray', async () => {
    healthz([
      { name: 'xray', engine: 'singbox', running: false, version: CORE_BINARIES['sing-box'].version },
    ]);
    const { cores } = (await ask()).json() as {
      cores: { protocol: string; core: string; engine: string; pinned: string; drift: boolean }[];
    };
    expect(cores[0]!.protocol).toBe('xray');
    expect(cores[0]!.engine).toBe('singbox');
    expect(cores[0]!.core).toBe('sing-box');
    expect(cores[0]!.pinned).toBe(CORE_BINARIES['sing-box'].version);
    expect(cores[0]!.drift, 'a node running exactly what the panel pins is not drifting').toBe(false);
  });

  it('still finds real drift when the engine is named', async () => {
    // The control: reading the engine must not turn the comparison off.
    healthz([{ name: 'tuic', engine: 'singbox', running: true, version: '0.0.1' }]);
    const { cores } = (await ask()).json() as { cores: { pinned: string; drift: boolean }[] };
    expect(cores[0]!.pinned).toBe(CORE_BINARIES['sing-box'].version);
    expect(cores[0]!.drift).toBe(true);
  });

  it('falls back to the protocol when the agent is too old to name an engine', async () => {
    // An agent that predates the field sends no `engine`, and must keep
    // reading exactly as it did before.
    healthz([{ name: 'xray', running: true, version: CORE_BINARIES.xray.version }]);
    const { cores } = (await ask()).json() as {
      cores: { core: string; engine: string | null; pinned: string; drift: boolean }[];
    };
    expect(cores[0]!.engine).toBeNull();
    expect(cores[0]!.core).toBe('xray');
    expect(cores[0]!.drift).toBe(false);
  });

  it('404s a node that is not there', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/nodes/00000000-0000-0000-0000-000000000000/cores`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
