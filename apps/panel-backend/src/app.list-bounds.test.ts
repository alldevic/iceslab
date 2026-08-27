import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/**
 * Which collection endpoints take a page, and why the rest do not need one.
 *
 * Two of the panel's nine collection routes accept `page`/`limit` — users and
 * nodes — and the other seven answer with everything. Nothing said whether that
 * was a decision or an oversight, which is the state this file ends: an
 * unpaged list is allowed here only with the reason it is bounded, and a new
 * one has to be paged or named.
 *
 * The reasons are not guesses. Every route that WRITES these tables is
 * admin-authed (`app.route-auth.test.ts` asks all 185 routes what they do with
 * no credentials, and every one of these answers 401), and nothing else creates
 * their rows — no subscriber action, no facade call, no cron. So their size is
 * bounded by what an operator typed, which is the property that makes an
 * unpaged list safe. `users` is the counter-example and is paged: a storefront
 * creates those.
 *
 * Measured on the lab panel 2026-08-28, for scale rather than proof: hosts 6,
 * profiles 4, squads 8, cascades 1, srr 0, policies 0, regions 0 — against 361
 * users. The one that grows with the FLEET rather than with typing is hosts
 * (one per profile×node binding); it is named as the one to page first if a
 * deployment ever makes that number uncomfortable.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** Collection GETs: `/api/<thing>` with no path parameter. */
function collectionRoutes(tree: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (!raw.trim()) continue;
    const marker = raw.search(/[└├]── /);
    const depth = marker < 0 ? 0 : marker / 4;
    const seg = marker < 0 ? '' : raw.slice(marker + 4);
    const m = seg.match(/^(.*?) \(([A-Z, ]+)\)\s*$/);
    let part = m ? m[1]! : seg;
    if (part.startsWith('(empty root node')) part = '';
    stack.length = depth;
    stack[depth] = part;
    if (!m || !m[2]!.split(', ').includes('GET')) continue;
    const url = stack.slice(0, depth + 1).join('');
    if (!url.startsWith('/api/')) continue;
    if (url.includes(':') || url.includes('*')) continue;
    // Sub-resources and singletons are not collections.
    if (url.split('/').length !== 3) continue;
    out.push(url);
  }
  return [...new Set(out)];
}

/** Routes that take a page. */
const PAGED = new Set(['/api/users', '/api/nodes']);

/**
 * Routes that answer with everything, and the reason each is bounded. A reason
 * is a sentence about WHO creates the rows, because that is what decides it.
 */
const BOUNDED: Record<string, string> = {
  '/api/hosts':
    'one per profile×node binding, all admin-created. The largest of these in a real fleet, and the first to page if it ever stops being comfortable.',
  '/api/profiles': 'admin-authored inbound templates; a fleet has a handful.',
  '/api/bindings': 'profile×node, created by an admin deploying a profile.',
  '/api/squads': 'admin-authored access groups.',
  '/api/cascades': 'admin-authored routes out; a fleet has a few.',
  '/api/srr': 'admin-authored delivery rules, ordered by hand.',
  '/api/route-policies': 'bounded by MAX_DIRECTION_ORDINAL, which is the tag band.',
  '/api/regions': 'admin-authored labels for grouping nodes.',
  '/api/settings': 'a singleton row, not a collection, but it answers on a collection-shaped path.',
  '/api/api-tokens':
    'one per token an admin minted, and the screen that lists them is the one that mints them.',
};

describe('every collection route is paged, or bounded for a reason', () => {
  it('finds collection routes at all', () => {
    // The control: an empty scan makes both comparisons below vacuous.
    const found = collectionRoutes(app.printRoutes());
    expect(found.length).toBeGreaterThan(5);
    expect(found).toContain('/api/users');
  });

  it('leaves none of them undecided', () => {
    const undecided = collectionRoutes(app.printRoutes()).filter(
      (r) => !PAGED.has(r) && !(r in BOUNDED),
    );
    expect(
      undecided.sort(),
      'a new collection route: give it page/limit, or name here who creates its rows and why that bounds it',
    ).toEqual([]);
  });

  it('and names none that is gone', () => {
    const found = new Set(collectionRoutes(app.printRoutes()));
    expect([...PAGED, ...Object.keys(BOUNDED)].filter((r) => !found.has(r)).sort()).toEqual([]);
  });

  it('the paged ones really do take a limit', () => {
    // Otherwise `PAGED` is a claim about routes rather than a fact about them.
    // Read across the whole module, not just its routes file: nodes declares
    // its query schema in `nodes.schemas.ts`, and the first draft of this case
    // looked only at the routes and called a paged route unpaged.
    for (const mod of ['users', 'nodes']) {
      const dir = join(import.meta.dirname, 'modules', mod);
      const src = readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('\n');
      expect(src, `${mod} is listed as paged and mentions no limit`).toMatch(/limit/);
    }
  });
});
