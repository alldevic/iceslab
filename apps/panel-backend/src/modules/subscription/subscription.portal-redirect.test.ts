import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerBindingsCacheBust } from './subscription.bindings-cache.js';

/**
 * Who `/sub/<token>` is answering: a person or a client (CLIENT_PORTAL_URL set).
 *
 * The same URL is fetched by both. The VPN client needs the subscription; the
 * buyer sometimes taps the link and lands on this panel's page. With a portal
 * named, a browser goes there, and the redirect is only right if it leaves
 * everything else as it was. The config is read once at load, so the unset case
 * is its own file (subscription.portal-absent.test.ts).
 */

const PORTAL = 'https://shop.example.com/app';
const BROWSER = { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

let app: FastifyInstance;
let prisma: typeof import('../../prisma.js').prisma;
let userId: string;
let token: string;

beforeAll(async () => {
  process.env['CLIENT_PORTAL_URL'] = PORTAL;
  registerBindingsCacheBust();
  const [{ buildApp }, prismaMod, { cleanDatabase }, { registerAndLogin }] = await Promise.all([
    import('../../app.js'),
    import('../../prisma.js'),
    import('../../../tests/helpers/db.js'),
    import('../../../tests/helpers/auth.js'),
  ]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await cleanDatabase();
  const admin = await registerAndLogin(app);
  const auth = { authorization: `Bearer ${admin}` };
  const node = await app.inject({ method: 'POST', url: '/api/nodes', headers: auth, payload: { name: 'portal-n', address: '10.0.0.51:8443' } });
  const profile = await app.inject({ method: 'POST', url: '/api/profiles', headers: auth, payload: { name: 'portal-h', protocol: 'hysteria', config: {} } });
  await app.inject({
    method: 'POST', url: '/api/bindings', headers: auth,
    payload: { profileId: JSON.parse(profile.body).id, nodeId: JSON.parse(node.body).id, port: 443 },
  });
  const created = await app.inject({ method: 'POST', url: '/api/users', headers: auth, payload: { username: 'portal-user' } });
  expect(created.statusCode, created.body).toBe(201);
  const body = JSON.parse(created.body);
  userId = body.id;
  token = body.subscriptionToken;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  const { closeRedis } = await import('../../lib/infra/redis.js');
  await closeRedis();
  delete process.env['CLIENT_PORTAL_URL'];
});

const get = (headers: Record<string, string>, query = '') =>
  app.inject({ method: 'GET', url: `/sub/${token}${query}`, headers });

describe('a portal takes over the human half of /sub', () => {
  it('sends a browser to the portal instead of the page', async () => {
    const res = await get(BROWSER);
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(PORTAL);
  });

  it('does not append the token to another origin', async () => {
    const res = await get(BROWSER);
    expect(String(res.headers['location'])).not.toContain(token);
  });

  it('leaves the CLIENT alone: it still gets the subscription', async () => {
    const res = await get({ 'user-agent': 'Happ/1.0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(Buffer.from(res.body, 'base64').toString('utf8')).not.toContain('<html');
  });

  it('leaves an explicit ?format= alone, even from a browser', async () => {
    const plain = await get(BROWSER, '?format=plain');
    expect(plain.statusCode).toBe(200);
    expect(Buffer.from(plain.body, 'base64').toString('utf8')).not.toContain('<html');
    const json = await get(BROWSER, '?format=json');
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
  });

  it('gives the page, not the portal, to a link that names a tunnel', async () => {
    for (const qs of ['?node=abcd1234', '?node=abcd1234&device=2', '?protocols=hysteria&node=abcd1234']) {
      const res = await get(BROWSER, qs);
      expect(res.statusCode, qs).toBe(200);
      expect(res.headers['content-type'], qs).toContain('text/html');
    }
  });

  it('a protocols narrowing alone is not a tunnel: still the portal', async () => {
    const res = await get(BROWSER, '?protocols=hysteria');
    expect(res.statusCode).toBe(302);
  });
});

describe('a subscription that is not in force, with a portal', () => {
  it('sends the browser of an expired or revoked subscription to the portal too, the JSON refusal unchanged for clients', async () => {
    await prisma.user.update({ where: { id: userId }, data: { status: 'expired' } });
    const browser = await get(BROWSER);
    expect(browser.statusCode).toBe(302);
    expect(browser.headers['location']).toBe(PORTAL);
    expect(String(browser.headers['location'])).not.toContain(token);

    const client = await get({ 'user-agent': 'Happ/1.0' });
    expect(client.statusCode).toBe(403);
    expect(JSON.parse(client.body).error).toBe('FORBIDDEN');

    // A tunnel link keeps the page of refusal: it is not redirected either.
    const tunnel = await get(BROWSER, '?node=abcd1234');
    expect(tunnel.statusCode).toBe(403);
    expect(tunnel.headers['content-type']).toContain('text/html');
    await prisma.user.update({ where: { id: userId }, data: { status: 'active' } });
  });
});
