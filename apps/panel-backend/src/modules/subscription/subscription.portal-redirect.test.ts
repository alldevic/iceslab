import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Who `/sub/<token>` is answering: a person or a client.
 *
 * The same URL is fetched by both. The VPN client needs the config; the buyer
 * sometimes taps the link and, until now, landed on this panel's install page.
 * The product decision is that people belong in the shop - the panel is an
 * internal tool that happens to sit in the external perimeter - so a browser is
 * redirected when the operator names a portal.
 *
 * All four cases are here because the redirect is only correct if it leaves the
 * other three exactly as they were. The risk in a change like this is never the
 * case you added; it is the client that stops getting its config.
 */

const PORTAL = 'https://shop.example.com/app';

let app: FastifyInstance;
let prisma: typeof import('../../prisma.js').prisma;
let token: string;

beforeAll(async () => {
  process.env['CLIENT_PORTAL_URL'] = PORTAL;
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
      username: `portal-${Date.now()}`,
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
  delete process.env['CLIENT_PORTAL_URL'];
});

const get = (headers: Record<string, string>, query = '') =>
  app.inject({ method: 'GET', url: `/sub/${token}${query}`, headers });

describe('a portal takes over the human half of /sub', () => {
  it('sends a browser to the portal instead of showing panel UI', async () => {
    const res = await get({ accept: 'text/html,application/xhtml+xml' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(PORTAL);
  });

  it('does not append the token to another origin', async () => {
    // The token IS the subscription credential. In a redirect target it lands
    // in the shop's access logs and in Referer headers on every asset that page
    // loads. The shop identifies its own visitors; it has no use for ours.
    const res = await get({ accept: 'text/html' });
    expect(res.headers['location']).not.toContain(token);
  });

  it('leaves the CLIENT alone - it still gets its config', async () => {
    // The case that matters most and is easiest to break: a VPN client sends no
    // text/html, and must keep getting the same base64 list it always did.
    const res = await get({ 'user-agent': 'Happ/1.0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Base64 of a URI list, not an HTML page and not a redirect body.
    expect(Buffer.from(res.body, 'base64').toString('utf8')).not.toContain('<html');
  });

  it('leaves an explicit ?format= alone, even from a browser', async () => {
    // Asking for a format is asking for a config on purpose - our own admin UI,
    // and every debugging curl, do it from something that also sends text/html.
    // Redirecting those would break the thing this change is meant not to touch.
    const res = await get({ accept: 'text/html' }, '?format=json');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
