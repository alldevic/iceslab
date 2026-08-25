import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * With no portal named, `/sub` behaves exactly as it did.
 *
 * The counterpart to subscription.portal-redirect.test.ts, and it lives in its
 * own file because the setting is read once when config loads - flipping it
 * mid-file would test the mock rather than the code.
 *
 * This is the property that protects everyone who has not split their surfaces:
 * an operator with no shop, or one who has not switched yet, must not lose the
 * page. It is the only place their buyers get AmneziaWG QR pairs - the shop's
 * own install guide lists no WireGuard client at all - so a redirect that
 * defaulted to on would take those buyers offline with nothing to show them.
 */

let app: FastifyInstance;
let prisma: typeof import('../../prisma.js').prisma;
let token: string;

beforeAll(async () => {
  delete process.env['CLIENT_PORTAL_URL'];
  const [{ buildApp }, prismaMod, creds] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
    import('../../lib/credentials.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  const c = creds.generateUserCredentials();
  const user = await prisma.user.create({
    data: {
      username: `noportal-${Date.now()}`,
      shortId: c.shortId,
      subscriptionToken: c.subscriptionToken,
      hysteriaPassword: c.hysteriaPassword,
      naivePassword: c.naivePassword,
      xrayUuid: c.xrayUuid,
      amneziawgPrivateKey: c.amneziawgPrivateKey,
      amneziawgPublicKey: c.amneziawgPublicKey,
    },
  });
  token = user.subscriptionToken;
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany({ where: { subscriptionToken: token } });
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/redis.js');
  await closeRedis();
});

describe('without a portal, /sub keeps its install page', () => {
  it('still renders the page to a browser', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode, 'a browser was redirected with no portal configured').toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<html');
  });

  it('and still answers a client with its config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sub/${token}`,
      headers: { 'user-agent': 'Happ/1.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});
