import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownScope, SCOPEABLE_RESOURCES, UNSCOPED_RESOURCES } from './scope.hook.js';

/**
 * A-040: the scopeable resources are a list kept by hand, and it drifted from
 * the routes: four resources (route-policies, node-policies, named-outbounds,
 * geo-sets) had routes and no scope, so a scoped token could not be given
 * them at all. This reads every `/api/<segment>` the backend source names,
 * the way the audit found the drift, and every one has to be scopeable or
 * named as never reachable by a token.
 */

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'generated') out.push(...sources(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function routeSegments(): Set<string> {
  const seen = new Set<string>();
  // A route registration: the method call, then the path, possibly on the next line.
  const re = /\.(?:get|post|put|patch|delete|head)\(\s*['`]\/api\/([a-z0-9-]+)/g;
  for (const file of sources(src)) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) seen.add(m[1]!);
  }
  return seen;
}

describe('scopes against routes', () => {
  it('every /api/<segment> the backend registers is scopeable or never reachable by a token', () => {
    const segments = routeSegments();
    expect(segments.size).toBeGreaterThan(10); // the reader found the routes at all
    const known = new Set<string>([...SCOPEABLE_RESOURCES, ...UNSCOPED_RESOURCES]);
    const missing = [...segments].filter((s) => !known.has(s)).sort();
    expect(missing, 'routes with no scope: add them to SCOPEABLE_RESOURCES').toEqual([]);
  });

  it('every scopeable resource has a route, so no scope is a dead one', () => {
    const segments = routeSegments();
    const dead = SCOPEABLE_RESOURCES.filter((r) => !segments.has(r));
    expect(dead).toEqual([]);
  });

  it('the four that were missing can be minted now', () => {
    for (const r of ['route-policies', 'node-policies', 'named-outbounds', 'geo-sets']) {
      expect(isKnownScope(`${r}:read`), r).toBe(true);
      expect(isKnownScope(`${r}:write`), r).toBe(true);
    }
  });
});
