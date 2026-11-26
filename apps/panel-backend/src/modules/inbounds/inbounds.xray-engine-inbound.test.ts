import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { getLogger } from '../../lib/infra/logger.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import * as cascadeService from '../cascades/cascade.service.js';
import type { XrayCascadeFragments } from '../cascades/cascade.service.js';
import { fetchEnabledInbounds, xrayEngineInbound } from './inbounds.queue.js';

vi.mock('../cascades/cascade.service.js', async (orig) => ({
  ...(await orig<typeof import('../cascades/cascade.service.js')>()),
  getCascadeFragmentsForNode: vi.fn(),
}));

/**
 * Per-node routing (cascade, WARP) rides the one xray config.json, so it goes
 * on an inbound the xray ENGINE serves. An xray-protocol inbound on sing-box
 * cannot carry it: the agent refused the cascade (the whole push with it) and
 * dropped WARP silently, the node showing WARP on.
 */
describe('xrayEngineInbound', () => {
  it('skips an xray inbound on sing-box and takes the next one on xray', () => {
    const got = xrayEngineInbound([
      { id: 'sb', protocol: 'xray', engine: 'singbox' as const },
      { id: 'hy', protocol: 'hysteria' },
      { id: 'xr', protocol: 'xray' },
    ]);
    expect(got?.id).toBe('xr');
  });

  it('an explicit xray engine counts; none at all is none', () => {
    expect(xrayEngineInbound([{ id: 'x', protocol: 'xray', engine: 'xray' as const }])?.id).toBe('x');
    expect(xrayEngineInbound([{ id: 'sb', protocol: 'xray', engine: 'singbox' as const }])).toBeUndefined();
  });
});

/**
 * The same rule through the push itself: what a node is handed when its xray
 * profiles run on sing-box, on the xray engine, or both.
 */
describe('cascade and WARP in the push of a node', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    await cleanDatabase();
    token = await registerAndLogin(app);
    vi.mocked(cascadeService.getCascadeFragmentsForNode).mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

  const reality = {
    subprotocol: 'vless',
    security: 'reality',
    realityDest: 'www.microsoft.com:443',
    realityServerNames: ['www.microsoft.com'],
    realityPrivateKey: 'k'.repeat(43),
    realityPublicKey: 'p'.repeat(43),
    realityShortIds: ['0123abcd'],
    network: 'raw',
  };
  const fragments = { inbounds: [], outbounds: [], rules: [] } as unknown as XrayCascadeFragments;

  async function post(url: string, payload: unknown) {
    const res = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
    expect(res.statusCode, `${url} -> ${res.body}`).toBe(201);
    return JSON.parse(res.body) as { id: string };
  }

  async function nodeWith(engines: Array<'singbox' | 'xray' | undefined>) {
    const node = await prisma.node.create({
      data: {
        name: 'n-' + engines.join('-'),
        address: '203.0.113.20',
        protocol: 'xray',
        heartbeatSecret: randomBytes(32),
        warpEnabled: true,
        warpAccount: { secretKey: 's', address: ['172.16.0.2/32'], publicKey: 'p', endpoint: 'e:2408', reserved: [1, 2, 3] },
      },
    });
    let port = 8441;
    for (const engine of engines) {
      const profile = await post('/api/profiles', { name: `p-${port}`, protocol: 'xray', engine, config: reality });
      await post('/api/bindings', { profileId: profile.id, nodeId: node.id, port: port++ });
    }
    return node.id;
  }

  const carriers = (inbounds: Awaited<ReturnType<typeof fetchEnabledInbounds>>) =>
    inbounds.filter((i) => 'cascade' in (i.config as object) || 'warp' in (i.config as object));

  it('puts both on the inbound the xray engine serves, not on the sing-box one before it', async () => {
    vi.mocked(cascadeService.getCascadeFragmentsForNode).mockResolvedValue(fragments);
    const nodeId = await nodeWith(['singbox', 'xray']);
    const inbounds = await fetchEnabledInbounds(nodeId);
    expect(inbounds).toHaveLength(2);
    const on = carriers(inbounds);
    expect(on).toHaveLength(1);
    expect(on[0]!.engine ?? 'xray').toBe('xray');
    expect(on[0]!.config).toHaveProperty('cascade');
    expect(on[0]!.config).toHaveProperty('warp');
  });

  it('gives neither to a node whose xray profiles all run on sing-box, and says so', async () => {
    vi.mocked(cascadeService.getCascadeFragmentsForNode).mockResolvedValue(fragments);
    const info = vi.spyOn(getLogger(), 'info');
    const nodeId = await nodeWith(['singbox']);
    const inbounds = await fetchEnabledInbounds(nodeId);
    expect(inbounds).toHaveLength(1);
    expect(carriers(inbounds)).toHaveLength(0);
    const said = info.mock.calls.map((c) => String(c[0]));
    expect(said.some((m) => m.includes('no inbound on the xray engine; cascade not applied'))).toBe(true);
    expect(said.some((m) => m.includes('WARP enabled but no inbound on the xray engine'))).toBe(true);
  });

  it('a profile with no engine counts as the xray engine', async () => {
    const nodeId = await nodeWith([undefined]);
    const inbounds = await fetchEnabledInbounds(nodeId);
    expect(carriers(inbounds)).toHaveLength(1);
  });
});
