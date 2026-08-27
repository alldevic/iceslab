import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Models the schema keeps and the code must not grow back onto.
 *
 * `Inbound` and `GroupInbound` are slice-24 leftovers, superseded by Profile +
 * ProfileNodeBinding. Everything above them was removed on 2026-08-27 — there
 * was no /api/inbounds route and no service, `prisma.inbound` was queried
 * nowhere, three bus events sat subscribed with no emitter, and the frontend
 * carried four client functions no screen called. The TABLES are kept by the
 * operator's call: dropping columns on a live panel is irreversible and the
 * gain is tidiness.
 *
 * Kept is not the same as forgotten. A Prisma model stays in the generated
 * client forever, so `prisma.inbound.findMany()` compiles the day someone
 * reaches for it, and the next reader finds a model with queries against it and
 * concludes it is live. This is what makes that visible: not a lint rule, an
 * assertion with the reason attached.
 *
 * `User.preferredNodeId` is on the same list for the same reason — reserved,
 * NULL on every row, kept nullable so the idea survives without pretending to
 * work.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every non-test source file under src/, minus the generated client. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'generated' || name === 'node_modules') continue;
        walk(p);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      out.push(p);
    }
  };
  walk(HERE);
  return out;
}

/**
 * Source with comments removed.
 *
 * Written after this file failed on its own prose: the comments explaining WHY
 * `prisma.inbound` must not appear contain the string `prisma.inbound`, so the
 * first version reported the model as live. Block comments go entirely; for
 * line comments only whole comment LINES are dropped, never a trailing `//`,
 * because that would also cut a `https://` inside a string and could hide a
 * real call sitting after it.
 */
function body(): string {
  return sources()
    .map((p) =>
      readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n'),
    )
    .join('\n');
}

describe('models the schema keeps but the code has left behind', () => {
  const src = body();

  it('reads the sources it is comparing against', () => {
    // The control. An empty body makes every assertion below vacuous, which is
    // exactly the shape these assertions exist to catch elsewhere.
    expect(src.length).toBeGreaterThan(100_000);
    expect(src, 'the live model this pair was replaced by').toContain('profileNodeBinding');
  });

  it.each([
    ['prisma.inbound', 'Inbound'],
    ['prisma.groupInbound', 'GroupInbound'],
  ])('nothing queries %s', (accessor, model) => {
    expect(
      src.includes(accessor),
      `${model} is legacy: superseded by Profile + ProfileNodeBinding, kept only ` +
        `because dropping columns on a live panel is irreversible. A query here means ` +
        `either the model came back to life — then remove it from this list and say why — ` +
        `or someone reached for the wrong one.`,
    ).toBe(false);
  });

  it('nothing reads or writes User.preferredNodeId', () => {
    expect(
      src.includes('preferredNodeId'),
      'preferredNodeId is RESERVED and NULL on every row. Wiring it up means answering ' +
        'the two questions its original note never did: who sets it, and what happens ' +
        'when that node is unreachable. Do that, then delete this case.',
    ).toBe(false);
  });

  it('the schema still declares them, so this file has a subject', () => {
    // The other direction: a list that outlives its subject asserts nothing,
    // and would keep passing after a migration finally dropped the tables.
    const schema = readFileSync(resolve(HERE, '../prisma/schema.prisma'), 'utf8');
    for (const decl of ['model Inbound {', 'model GroupInbound {', 'preferredNodeId']) {
      expect(schema, `${decl} is gone from the schema; drop it from this file too`).toContain(decl);
    }
  });
});
