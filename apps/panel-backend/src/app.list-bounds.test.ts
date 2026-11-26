import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/**
 * Which collection endpoints take a page, and why the rest do not need one.
 *
 * Three of the panel's collection routes accept a `limit` - users, nodes and
 * audit (cursor-paged) - and the rest answer with everything. Nothing said
 * whether that was a decision or an oversight, which is the state this file
 * ends: an unpaged list is allowed here only with the reason it is bounded, and
 * a new one has to be paged or named.
 *
 * The reasons come from the code that creates the rows. Every route that writes
 * these tables is admin-authed (`app.route-auth.test.ts` asks every route what
 * it does with no credentials), and the only non-route writers are
 * `ensureBuiltinSets` (two fixed geo sets) and `ensureDefaultHost` (one host per
 * binding an admin creates). So their size is bounded by what an operator
 * typed, which is the property that makes an unpaged list safe. `users` is the
 * counter-example and is paged: a storefront creates those. `audit` grows by
 * itself with every admin action and is cursor-paged.
 *
 * HOW TO EXTEND (for every later milestone that adds a `GET /api/<name>`
 * collection): in the SAME merge, either give the route `limit` and add it to
 * PAGED, or add it to BOUNDED with a sentence naming who creates its rows and
 * what caps them. A collection whose rows are created by anything other than
 * an admin typing (a node, a subscriber, a cron, a facade call) must be paged,
 * not bounded. Expected additions: stage 10 (geo-by-token has no collection),
 * stage 14 (facade collections, if any), stage 16 (cold pool) and any milestone
 * with a new `/api/<name>` list. A route with a path parameter or a deeper path
 * is not a collection here and needs no entry.
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
const PAGED = new Set(['/api/users', '/api/nodes', '/api/audit']);

/**
 * Routes that answer with everything, and the reason each is bounded. A reason
 * is a sentence about WHO creates the rows, because that is what decides it.
 */
const BOUNDED: Record<string, string> = {
  // Not here: GET /api/internal/cores (milestone 7.1) lists the version manifest
  // (code, one row per artifact), is behind the agent's bearer, and is deeper
  // than /api/<name>, which collectionRoutes does not count.
  '/api/hosts':
    'admin-created, plus one auto "Default" host per binding an admin deploys. The largest of these in a real fleet (one per profile x node binding) and the first to page if it ever stops being comfortable.',
  '/api/profiles': 'admin-authored inbound templates (profiles.service createProfile); a fleet has a handful.',
  '/api/bindings': 'profile x node, created by an admin deploying a profile (createBinding is the only writer).',
  '/api/squads': 'admin-authored access groups (squads.service createSquad is the only writer).',
  '/api/cascades':
    'admin-authored chains (cascade.service createCascade); the SIZE of each is capped (MAX_CASCADE_PATH hops, MAX_CASCADE_LINKS links), the count is bounded by what an operator built.',
  '/api/srr': 'admin-authored subscription response rules, ordered by hand.',
  '/api/route-policies': 'admin-authored; bounded by MAX_DIRECTION_ORDINAL, which is the tag band, and ordinal is unique.',
  '/api/regions': 'admin-authored labels for grouping nodes.',
  '/api/settings':
    'not a collection: a fixed set of keys (every writable key is present, null when unset), one object.',
  '/api/api-tokens':
    'one per token an admin minted; minting is session-only (an API token cannot mint another), and the screen that lists them is the one that mints them.',
  '/api/geo-sets':
    'two built-in sets created on start (ensureBuiltinSets) plus operator-added ones, which only an admin creates.',
  '/api/named-outbounds': 'admin-authored named exits; a cascade references them by id.',
  '/api/node-policies': 'admin-authored routing policies for nodes (node-policies.service createPolicy is the only writer); a fleet has a handful.',
  '/api/routing-presets':
    'built-in presets (a fixed list in routing-presets.builtins) plus admin-authored ones; each preset is capped at MAX_PRESET_RULES rules.',
  '/api/subscription-templates':
    'admin-authored (one per client type and name); templates.service creates them from an admin import or edit.',
};

describe('every collection route is paged, or bounded for a reason', () => {
  it('finds collection routes at all', () => {
    // The control: an empty scan makes both comparisons below vacuous.
    const found = collectionRoutes(app.printRoutes());
    expect(found.length).toBeGreaterThan(10);
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
    for (const mod of ['users', 'nodes', 'audit']) {
      const dir = join(import.meta.dirname, 'modules', mod);
      const src = readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('\n');
      expect(src, `${mod} is listed as paged and declares no capped limit in its query schema`).toMatch(/\blimit:\s*z\.coerce\.number\(\)[^,]*\.max\(\d+\)/);
    }
  });
});
