import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The route-auth sweep (app.route-auth.test.ts) runs with the facade off, so it
// never sees these routes. This is the same question asked with it on: every
// facade route is closed to a caller with no credentials, and none is published
// on purpose (no line for the facade in that file's PUBLIC list).

let app: FastifyInstance;

beforeAll(async () => {
  process.env['REMNAWAVE_COMPAT_ENABLED'] = 'true';
  process.env['REMNAWAVE_COMPAT_PREFIX'] = 'rw';
  const { buildApp } = await import('../../app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** `METHOD /rw/api/...` for every facade route, read from the router's own text. */
function facadeRoutes(): { method: string; url: string }[] {
  const out: { method: string; url: string }[] = [];
  const stack: string[] = [];
  for (const raw of app.printRoutes().split('\n')) {
    const marker = raw.search(/[└├]── /);
    if (marker < 0) continue;
    const depth = marker / 4;
    const seg = raw.slice(marker + 4);
    const withMethods = seg.match(/^(.*?) \(([A-Z, ]+)\)\s*$/);
    stack.length = depth;
    let part = withMethods ? withMethods[1]! : seg;
    if (part.startsWith('(empty root node')) part = '';
    stack[depth] = part;
    if (!withMethods) continue;
    const url = stack.slice(0, depth + 1).join('');
    if (!url.startsWith('/rw/')) continue;
    for (const method of withMethods[2]!.split(', ')) {
      if (method !== 'HEAD' && method !== 'OPTIONS') out.push({ method, url });
    }
  }
  return out;
}

describe('facade routes without credentials', () => {
  it('finds the routes it asks about', () => {
    const routes = facadeRoutes();
    expect(routes.length).toBeGreaterThan(30);
    for (const r of routes) {
      expect(app.hasRoute({ method: r.method as 'GET', url: r.url }), `${r.method} ${r.url}`).toBe(true);
    }
  });

  it('answers 401 on every one', async () => {
    const open: string[] = [];
    for (const r of facadeRoutes()) {
      const url = r.url.replace(/:[A-Za-z]+/g, '1');
      const res = await app.inject({ method: r.method as 'GET', url });
      if (res.statusCode !== 401) open.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});
