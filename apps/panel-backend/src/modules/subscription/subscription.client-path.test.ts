import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The trap's alert is read here, not sent.
const alerts = vi.hoisted(() => [] as string[]);
vi.mock('../../lib/notify/telegram-notify.js', async (real) => ({
  ...(await real<typeof import('../../lib/notify/telegram-notify.js')>()),
  notifyTelegramAsync: (text: string) => {
    alerts.push(text);
  },
}));
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { prisma } from '../../prisma.js';
import { closeRedis, redis } from '../../lib/infra/redis.js';
import { config } from '../../config.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { registerAndLogin } from '../../../tests/helpers/auth.js';
import { invalidateSrrCache } from '../srr/srr.service.js';
import { CLIENT_SLUGS } from './subscription.routes.js';

/**
 * A-236 step 5: /sub/<token>/<client> is an explicit format, the same answer
 * as `?format=`, and it wins over the User-Agent rules. One case per slug.
 */
let app: FastifyInstance;
let token: string;
let sub: string;
const P = config.SUBSCRIPTION_PATH_PREFIX;

beforeAll(async () => {
  app = await buildApp();
  await cleanDatabase();
  invalidateSrrCache();
  token = await registerAndLogin(app);
  const auth = { authorization: `Bearer ${token}` };
  const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { name: 'cp-node', address: 'cp.test', protocol: 'xray' } });
  const profile = await app.inject({
    method: 'POST', url: '/api/profiles', headers: auth,
    payload: {
      name: 'cp-profile', protocol: 'xray',
      config: {
        security: 'reality', subprotocol: 'vless', network: 'raw',
        realityDest: 'www.microsoft.com:443', realityServerNames: ['www.microsoft.com'],
        realityPrivateKey: 'k'.repeat(43), realityPublicKey: 'p'.repeat(43), realityShortIds: ['0123abcd'],
      },
    },
  });
  await app.inject({
    method: 'POST', url: '/api/bindings', headers: auth,
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  const user = await app.inject({ method: 'POST', url: '/api/users', headers: auth, payload: { username: 'cp-user' } });
  sub = (await prisma.user.findUniqueOrThrow({ where: { id: JSON.parse(user.body).id as string }, select: { subscriptionToken: true } }))
    .subscriptionToken;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await closeRedis();
});

describe('/sub/<token>/<client>', () => {
  for (const [slug, format] of Object.entries(CLIENT_SLUGS)) {
    it(`${slug}: the same answer as ?format=${format}, over a User-Agent rule that says otherwise`, async () => {
      // Hiddify's rule says singbox; the path still decides.
      const ua = { 'user-agent': 'Hiddify/2.0' };
      const byPath = await app.inject({ method: 'GET', url: `${P}/${sub}/${slug}`, headers: ua });
      const byQuery = await app.inject({ method: 'GET', url: `${P}/${sub}?format=${format}`, headers: ua });
      expect(byPath.statusCode, byPath.body).toBe(200);
      expect(byPath.headers['content-type']).toBe(byQuery.headers['content-type']);
      expect(byPath.body).toBe(byQuery.body);
    });
  }

  it('the slugs are the plan\'s list (4.4)', () => {
    expect(Object.keys(CLIENT_SLUGS).sort()).toEqual(['base64', 'clash', 'json', 'mihomo', 'raw', 'singbox', 'stash']);
  });

  it('an unknown client is answered by name, a bad token stays 404 as without a client', async () => {
    const res = await app.inject({ method: 'GET', url: `${P}/${sub}/surfboardx` });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string; message: string };
    expect(body.error).toBe('UNKNOWN_CLIENT');
    for (const slug of Object.keys(CLIENT_SLUGS)) expect(body.message).toContain(slug);
    const bare = await app.inject({ method: 'GET', url: `${P}/not-a-token-12345?format=singbox` });
    const pathed = await app.inject({ method: 'GET', url: `${P}/not-a-token-12345/singbox` });
    expect(pathed.statusCode).toBe(bare.statusCode);
    expect(pathed.body).toBe(bare.body);
  });

  it('a honey token trips the trap whatever follows it: an unknown client, format or protocol', async () => {
    const honey = 'honey-token-step5-xxxxxxx';
    config.HONEY_USER_TOKENS.push(honey);
    const ip = '8.8.4.4';
    try {
      for (const url of [`${P}/${honey}/surfboardx`, `${P}/${honey}?format=nope`, `${P}/${honey}?protocols=nope`]) {
        await redis.del(`sec:blacklist:${ip}`);
        const res = await app.inject({ method: 'GET', url, remoteAddress: ip });
        // The trap's answer: a plausible empty 200 and a ban, not a 404 or a
        // 400 that tells the holder the token is live.
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toBe('');
        expect(await redis.get(`sec:blacklist:${ip}`), url).toBe('1');
      }
    } finally {
      config.HONEY_USER_TOKENS.splice(config.HONEY_USER_TOKENS.indexOf(honey), 1);
      await redis.del(`sec:blacklist:${ip}`);
    }
  });

  it('the alert names the format asked for, cut to 64 characters', async () => {
    const honey = 'honey-token-a255-xxxxxxxx';
    config.HONEY_USER_TOKENS.push(honey);
    alerts.length = 0;
    try {
      const res = await app.inject({ method: 'GET', url: `${P}/${honey}?format=${'x'.repeat(500)}`, remoteAddress: '10.0.0.9' });
      expect(res.statusCode).toBe(200);
      expect(alerts).toHaveLength(1);
      const asked = /format: `([^`]*)`/.exec(alerts[0]!)![1]!;
      expect(asked).toBe('x'.repeat(64));
    } finally {
      config.HONEY_USER_TOKENS.splice(config.HONEY_USER_TOKENS.indexOf(honey), 1);
    }
  });
});
