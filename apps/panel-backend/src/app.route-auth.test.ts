// Every route the panel registers, asked the one question that has the same
// right answer for almost all of them: what happens to a caller with no
// credentials at all.
//
// Each module gates itself. Each route file writes `requireAuth`
// again — some per route, some as a scope hook, one wrapping a third-party
// plugin (bull-board) — and nothing ever compared them. A route added without
// the hook looks exactly like the others in review: same file, same style, same
// `app.get(...)`, and it answers strangers. That is a shape worth
// checking mechanically, so it is asked here of the whole surface at once rather than one
// module at a time.
//
// Asked of the BUILT APP, not of the source. A guard can be written and still
// not run (wrong hook phase, wrong encapsulation scope), and reading the file
// cannot tell the difference — the app can.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

/**
 * The routes the app actually has, read out of its own router.
 *
 * `printRoutes()` prints the radix tree, so a path arrives split across
 * branches (`/a` → `pi/` → `auth/` → `login`) and a pattern is the
 * concatenation down one branch. That reconstruction is not trusted: every
 * result is put back to `hasRoute`, which answers from the router itself, and
 * the count of ones it does not recognise is asserted to be zero. Without that
 * control a parser that quietly dropped half the tree would leave this file
 * green while testing nothing — and it did drop things: `printRoutes({
 * commonPrefix: false })`, the obvious spelling, renders `/admin/queues/static/
 * *` as a bare `*` and loses the segment.
 */
function routesOf(tree: string): { method: string; pattern: string }[] {
  const out: { method: string; pattern: string }[] = [];
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (!raw.trim()) continue;
    const marker = raw.search(/[└├]── /);
    // One level of nesting is four characters of prefix ("│   " or "    ").
    const depth = marker < 0 ? 0 : marker / 4;
    const seg = marker < 0 ? '' : raw.slice(marker + 4);
    const withMethods = seg.match(/^(.*?) \(([A-Z, ]+)\)\s*$/);
    let part = withMethods ? withMethods[1]! : seg;
    if (part.startsWith('(empty root node')) part = '';
    stack.length = depth;
    stack[depth] = part;
    if (!withMethods) continue;
    const pattern = stack.slice(0, depth + 1).join('');
    for (const method of withMethods[2]!.split(', ')) out.push({ method, pattern });
  }
  return out;
}

/**
 * The routes that answer a stranger on purpose, each with the reason it has to.
 * Adding a line here is the decision to publish a route; that is why the list
 * is spelled out rather than derived from a prefix.
 *
 * HOW TO EXTEND (for every later milestone that adds a route): a new route
 * either gets `requireAuth` (and nothing here), or gets one line here in the
 * SAME merge, as `'METHOD /pattern': 'why it must answer without a session'`,
 * with the pattern spelled as `printRoutes()` prints it. A stale line (route
 * gone, or now answering 401) fails too. Expected additions: stage 10 (geo by
 * token, `GET /geo/:token/:name`), stage 14 (facade routes, e.g.
 * `/rw/api/sub/:token`, only when the facade flag is on in this test's
 * environment), stage 16 and any other milestone with a route.
 */
const PUBLIC: Record<string, string> = {
  'GET /health':
    'the container healthcheck and every uptime probe; says only ok/db/redis',
  'GET /api/auth/status':
    'tells the login screen whether an admin exists yet, so it can offer setup',
  'POST /api/auth/login': 'the way a session is obtained in the first place',
  'POST /api/auth/logout':
    'a signed-out or expired session has to be able to clear its cookie; it only revokes the token it is shown (auth.routes.ts says so)',
  'POST /api/auth/register':
    'first-admin bootstrap; it is the absence of any admin that gates it, and it is 409 once one exists',
  'GET /api/settings/public':
    'branding the login screen renders before anybody is logged in',
  'GET /api/settings/subscription/preview/:token':
    'the operator\'s preview iframe cannot send a bearer; a 15-minute uuid token minted by the authed preview-url route is the credential, and the page is built from invented data',
  'GET /api/internal/bootstrap/:token':
    'a node collecting its enrolment payload; the single-use token in the path IS the credential',
  'GET /sub/:token':
    "the subscription a buyer's client polls; the token in the path is the credential (path follows SUBSCRIPTION_PATH_PREFIX, default /sub)",
  'GET /sub/:token/:client':
    'the same subscription with the client format chosen in the path; same token credential',
};

beforeAll(async () => {
  const { buildApp } = await import('./app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('the whole route table, asked without credentials', () => {
  it('is enumerated exactly, or the sweep below proves nothing', () => {
    const tree = app.printRoutes();
    const rs = routesOf(tree);
    // A floor rather than an exact count: routes get added, and a test that
    // needed editing on every new route would be edited without being read.
    // What this catches is the tree going empty or nearly so.
    // Measured on v0.3.1 + milestones 4.1-4.4: 261 entries (181 once HEAD and
    // OPTIONS are set aside).
    expect(rs.length).toBeGreaterThan(200);
    // And the count, counted a second way — straight off the text, without the
    // tree walk. `hasRoute` below says every pattern the walk PRODUCED is real;
    // it cannot say the walk produced them all, and a parser that dropped a
    // whole branch would still clear the floor above.
    const declared = (tree.match(/\(([A-Z]+, )*[A-Z]+\)\s*$/gm) ?? []).reduce(
      (n, m) => n + m.replace(/[()\s]/g, '').split(',').length,
      0,
    );
    expect(rs.length).toBe(declared);
    const unknown = rs
      .filter((r) => r.method !== 'OPTIONS')
      .filter((r) => !app.hasRoute({ method: r.method as 'GET', url: r.pattern }))
      .map((r) => `${r.method} ${r.pattern}`);
    expect(unknown).toEqual([]);
  });

  it('answers 401 everywhere except the routes that are published on purpose', async () => {
    const rs = routesOf(app.printRoutes()).filter(
      // HEAD is fastify's mirror of the GET beside it, and OPTIONS is the CORS
      // preflight, which is public by definition.
      (r) => r.method !== 'HEAD' && r.method !== 'OPTIONS',
    );

    const surprises: string[] = [];
    const publicSeen = new Set<string>();
    let i = 0;
    for (const r of rs) {
      i += 1;
      const key = `${r.method} ${r.pattern}`;
      const url = r.pattern
        .replace(/:[A-Za-z0-9_|:]+/g, 'aaaaaaaa')
        .replace(/\*/g, 'probe/asset');
      const res = await app.inject({
        method: r.method as 'GET',
        url,
        // A fresh source address per request. The global limiter is 100/min
        // keyed by IP, and a sweep of ~180 routes from one address would start
        // answering 429 halfway through — which is neither 401 nor a finding.
        remoteAddress: `10.${Math.floor(i / 250) + 1}.${i % 250}.7`,
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
      });
      if (res.statusCode === 429) {
        surprises.push(`${key} — 429, the sweep outran the rate limiter`);
        continue;
      }
      if (key in PUBLIC) {
        publicSeen.add(key);
        // A published route still has to answer as itself. 401 here would mean
        // the list is stale in the other direction: a route documented as
        // public that has since been closed.
        expect(res.statusCode, `${key} is listed public and answered 401`).not.toBe(401);
        continue;
      }
      if (res.statusCode !== 401) surprises.push(`${key} — ${res.statusCode}`);
    }

    expect(surprises).toEqual([]);
    // The other direction: a line in PUBLIC whose route no longer exists is a
    // permission granted to nothing, and it hides the day it comes back.
    expect(Object.keys(PUBLIC).filter((k) => !publicSeen.has(k))).toEqual([]);
  }, 120_000);
});
