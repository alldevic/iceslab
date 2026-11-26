import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// REMNAWAVE_COMPAT_ENABLED unset: the default. No facade route exists and the
// native API answers as it does without the module.

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
const token = `icp_rwoff_${Date.now()}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const auth = { authorization: `Bearer ${token}` };

beforeAll(async () => {
  delete process.env['REMNAWAVE_COMPAT_ENABLED'];
  delete process.env['REMNAWAVE_COMPAT_PREFIX'];
  const [{ buildApp }, prismaMod] = await Promise.all([import('../../app.js'), import('../../prisma.js')]);
  prisma = prismaMod.prisma;
  app = await buildApp();
  await app.ready();
  await prisma.apiToken.create({ data: { name: 'rwoff', tokenHash: sha(token), scopes: [] } });
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { tokenHash: sha(token) } });
  await app.close();
});

describe('facade flag off (default)', () => {
  it('has no route under the prefix, even for a valid token', async () => {
    for (const [method, url] of [
      ['GET', '/rw/api/system/metadata'],
      ['GET', '/rw/api/users'],
      ['POST', '/rw/api/users'],
      ['GET', '/rw/api/nodes'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(app.printRoutes()).not.toContain('/rw/');
  });

  it('answers 404 in the base shape, not in the Remnawave envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/rw/api/system/metadata', headers: auth });
    expect(res.json()).not.toHaveProperty('errorCode');
    expect(res.json()).not.toHaveProperty('response');
  });

  it('leaves the native API as it was', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('users');
    const unauth = await app.inject({ method: 'GET', url: '/api/users' });
    expect(unauth.statusCode).toBe(401);
  });
});
