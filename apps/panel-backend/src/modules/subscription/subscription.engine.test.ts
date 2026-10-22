import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { generateSubscription } from './subscription.service.js';
import { buildSingboxJson } from './formats/singbox.js';

/**
 * The share link depends on the CORE, not only on the protocol.
 *
 * hysteria2 served by its own daemon and hysteria2 served by xray are the same
 * protocol and different dialects: xray's has no Salamander obfuscation at all
 * (Xray-core v26.3.27, transport/internet/hysteria/config.proto, checked
 * 2026-09-12). A link carrying `obfs=salamander` handed to a client of an
 * xray-served inbound makes it obfuscate into a server that does not
 * deobfuscate. Nothing errors. The handshake simply never completes, and on the
 * operator's screen it reads as a dead node.
 *
 * So the rule under test is: the obfs password is STORED on the profile either
 * way, and whether it reaches the client is decided by the engine.
 */
let app: FastifyInstance;
let token: string;
let seq = 0;

beforeEach(async () => {
  app = await buildApp();
  await cleanDatabase();
  token = await registerAndLogin(app);
  seq = 0;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** Deploy one hysteria profile with obfs on `engine`, and return the user's
 *  endpoints as the subscription pipeline builds them. */
async function hysteriaEndpoints(
  engine: 'hysteria' | 'singbox' | 'xray',
  config: Record<string, unknown> = { obfsPassword: 'salt-pw', brutalUpMbps: 100, brutalDownMbps: 200 },
) {
  seq += 1;
  const node = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers: auth(),
    payload: { name: `eng-node-${seq}`, address: `eng-${seq}.test`, protocol: 'hysteria' },
  });
  expect(node.statusCode, node.body).toBe(201);
  const nodeId = JSON.parse(node.body).id as string;

  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth(),
    payload: {
      name: `eng-profile-${seq}`,
      protocol: 'hysteria',
      // Pinning 'xray' is not offered to an operator yet and must not be until
      // this very behaviour exists; the row is written directly for that
      // reason, and the engine is what the test is about.
      ...(engine === 'hysteria' ? {} : { engine: 'singbox' }),
      config,
    },
  });
  expect(profile.statusCode, profile.body).toBe(201);
  const profileId = JSON.parse(profile.body).id as string;
  if (engine === 'xray') {
    await prisma.profile.update({ where: { id: profileId }, data: { engine: 'xray' } });
  }

  const binding = await app.inject({
    method: 'POST',
    url: '/api/bindings',
    headers: auth(),
    payload: { profileId, nodeId, port: 443 },
  });
  expect(binding.statusCode, binding.body).toBe(201);

  const user = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: auth(),
    payload: { username: `eng-user-${seq}` },
  });
  expect(user.statusCode, user.body).toBe(201);
  const subscriptionToken = (
    await prisma.user.findFirstOrThrow({
      where: { id: JSON.parse(user.body).id as string },
      select: { subscriptionToken: true },
    })
  ).subscriptionToken;

  const result = await generateSubscription(subscriptionToken, { ip: '127.0.0.1', userAgent: '' });
  return result.endpoints.filter((e) => e.protocol === 'hysteria');
}

describe('a hysteria link is built for the core that serves it', () => {
  it('keeps obfs for the native daemon', async () => {
    const [e] = await hysteriaEndpoints('hysteria');
    expect(e?.engine).toBe('hysteria');
    expect(e?.uri).toContain('obfs=salamander');
    expect(e?.uri).toContain('obfs-password=salt-pw');
  });

  it('keeps obfs for sing-box, which speaks it too', async () => {
    // The point is not "anything but the native daemon loses it": sing-box
    // implements Salamander, so the link is the same. Only xray is the odd one.
    const [e] = await hysteriaEndpoints('singbox');
    expect(e?.engine).toBe('singbox');
    expect(e?.uri).toContain('obfs=salamander');
  });

  it('drops obfs for xray, which has none', async () => {
    const [e] = await hysteriaEndpoints('xray');
    expect(e?.engine).toBe('xray');
    expect(e?.uri).not.toContain('obfs');
    // The rest of the link is unchanged: only the part the core cannot honour
    // is gone, and the structured field goes with it so the clash and sing-box
    // formatters do not re-add it.
    expect(e?.uri).toContain('hysteria2://');
    expect(e?.obfsPassword).toBeUndefined();
    // The client claims what it sends: the profile's down (A-154).
    expect(e?.upMbps).toBe(200);
  });

  it('still stores the obfs password on the profile either way', async () => {
    // The setting is not lost, it is not delivered. An operator switching the
    // engine back gets their obfuscation back with it.
    const [e] = await hysteriaEndpoints('xray');
    const profile = await prisma.profile.findFirstOrThrow({
      where: { id: (await prisma.profileNodeBinding.findFirstOrThrow({ select: { profileId: true } })).profileId },
      select: { config: true },
    });
    expect((profile.config as { obfsPassword?: string }).obfsPassword).toBe('salt-pw');
    expect(e?.uri).not.toContain('salt-pw');
  });
});

/**
 * A-154: with a bandwidth the node runs Brutal, and each direction takes the
 * lower of the server's and the client's claim. The subscription once claimed
 * a fixed 50 up / 100 down for every client, which capped a 500/200 profile at
 * a fraction of its speed. Now the client claims the profile's pair turned over
 * (the server's upload is the client's download), and nothing without one.
 */
describe('the client claims the profile bandwidth, or nothing', () => {
  const singboxOutbound = (e: Parameters<typeof buildSingboxJson>[0][number]) =>
    (JSON.parse(buildSingboxJson([e])) as { outbounds: Record<string, unknown>[] }).outbounds.find(
      (o) => o.type === 'hysteria2',
    )!;

  it('a 500 up / 200 down profile: the client claims 200 up / 500 down, in the link and in sing-box', async () => {
    const [e] = await hysteriaEndpoints('hysteria', { brutalUpMbps: 500, brutalDownMbps: 200 });
    const q = new URL(e!.uri).searchParams;
    expect(q.get('upmbps')).toBe('200');
    expect(q.get('downmbps')).toBe('500');
    const o = singboxOutbound(e!);
    expect(o.up_mbps).toBe(200);
    expect(o.down_mbps).toBe(500);
  });

  it('a profile without a bandwidth: no claim anywhere', async () => {
    const [e] = await hysteriaEndpoints('hysteria', {});
    const q = new URL(e!.uri).searchParams;
    expect(q.has('upmbps')).toBe(false);
    expect(q.has('downmbps')).toBe(false);
    const o = singboxOutbound(e!);
    expect(o).not.toHaveProperty('up_mbps');
    expect(o).not.toHaveProperty('down_mbps');
  });
});
