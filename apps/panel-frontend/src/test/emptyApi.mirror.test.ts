import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceFields } from './declarations';
import { EMPTY_API, isReadEndpoint } from './emptyApi';

/**
 * The empty-API double, held to the types it stands in for.
 *
 * A hand-written fixture is a second copy of the contract, and a second copy
 * drifts — quietly, because a screen reading a field the fixture forgot sees
 * `undefined` and either renders a blank or throws inside a render, and either
 * way the test that mounted it looks like it proved something. That is not
 * hypothetical: the first draft of `getDashboardOverview` here was
 * `{ nodes: [], users: {} }`, and DashboardPage reads `traffic.todayBytes` on
 * its first render.
 *
 * So nothing below writes a shape down twice. The declared return type of each
 * endpoint is read out of `lib/api.ts` (following the name into
 * `packages/shared` when it lives there) and compared with the fixture.
 *
 * Limit, stated rather than discovered: the comparison is TOP-LEVEL. It catches
 * a whole section of a response going missing, which is the failure this file
 * exists for; it does not catch a missing leaf three levels down.
 */

const API_SRC = readFileSync(join(import.meta.dirname, '..', 'lib', 'api.ts'), 'utf8');
const SHARED_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'shared', 'src');
const SHARED_SRC = readdirSync(SHARED_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(join(SHARED_DIR, f), 'utf8'))
  .join('\n');

/** `export async function NAME(...): Promise<T>` → T, for every read endpoint.
 *  Written as a scan rather than one regex because a parameter list here can
 *  itself contain braces and parentheses (`listUsers(params?: { ... })`). */
function declaredReturns(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/export async function ([A-Za-z0-9_]+)\s*\(/g)) {
    const name = m[1]!;
    let i = src.indexOf('(', m.index! + m[0].length - 1);
    let depth = 0;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const tail = src.slice(i + 1);
    const p = tail.match(/^\s*:\s*Promise<([\s\S]*)/);
    if (!p) continue;
    // Close the Promise<...> by counting angle brackets.
    let angle = 1;
    let end = 0;
    const body = p[1]!;
    for (; end < body.length; end += 1) {
      if (body[end] === '<') angle += 1;
      else if (body[end] === '>') {
        angle -= 1;
        if (angle === 0) break;
      }
    }
    out.set(name, body.slice(0, end).trim().replace(/\s+/g, ' '));
  }
  return out;
}

/** Top-level property names of an inline object-literal type. */
function literalKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let member = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1 && (ch === ';' || ch === ',')) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(member);
      if (m) keys.push(m[1]!);
      member = '';
    } else if (depth >= 1 && i > 0) {
      member += ch;
    }
  }
  const last = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(member);
  if (last) keys.push(last[1]!);
  return keys;
}

const RETURNS = declaredReturns(API_SRC);

describe('the parser this file stands on', () => {
  it('reads a return type past a parameter list that has its own braces', () => {
    // listUsers is the case that broke the obvious `\(([^)]*)\)` version.
    expect(RETURNS.get('listUsers')).toBe('UsersListResponse');
    expect(RETURNS.get('listProfiles')).toBe('{ profiles: Profile[] }');
    expect(RETURNS.get('getNextFreePort')).toBe('number');
  });

  it('reads the top level of an inline literal and stops there', () => {
    expect(literalKeys('{ a: string; b: { c: number; d: number }; e: X[] }')).toEqual([
      'a',
      'b',
      'e',
    ]);
  });
});

describe('every read endpoint has an empty response, and only read endpoints do', () => {
  const declared = [...RETURNS.keys()].filter(isReadEndpoint).sort();

  it('finds the endpoints at all', () => {
    // The control: an empty scan would make both comparisons below vacuous.
    expect(declared.length).toBeGreaterThan(25);
    expect(declared).toContain('listNodes');
  });

  it('leaves none of them without one', () => {
    expect(
      declared.filter((n) => !(n in EMPTY_API)),
      'a screen reaching this endpoint would get a rejection naming it; declare its empty response',
    ).toEqual([]);
  });

  it('and names none that is gone', () => {
    expect(Object.keys(EMPTY_API).filter((n) => !declared.includes(n)).sort()).toEqual([]);
  });
});

describe('each empty response is shaped like the type it stands in for', () => {
  for (const name of Object.keys(EMPTY_API).sort()) {
    it(name, () => {
      const type = RETURNS.get(name);
      expect(type, `${name} is not declared in api.ts`).toBeTruthy();
      const value = EMPTY_API[name];

      // `X | null`: the empty answer is the null half, and saying so is the point.
      if (/\|\s*null\s*$/.test(type!)) {
        expect(value, `${name} returns \`${type}\`; empty is null`).toBeNull();
        return;
      }
      if (type === 'number' || type === 'string' || type === 'boolean') {
        expect(typeof value).toBe(type);
        return;
      }
      if (/\[\]$/.test(type!)) {
        expect(Array.isArray(value), `${name} returns an array`).toBe(true);
        return;
      }

      const want = type!.startsWith('{')
        ? literalKeys(type!)
        : (() => {
            for (const src of [API_SRC, SHARED_SRC]) {
              try {
                return interfaceFields(src, type!);
              } catch {
                /* look in the next file */
              }
            }
            throw new Error(`interface ${type} not found in api.ts or packages/shared`);
          })();

      // The control on the resolution: a type that resolved to nothing would
      // make the comparison below pass for any fixture at all.
      expect(want.length, `${type} resolved to no fields`).toBeGreaterThan(0);

      const got = Object.keys(value as object);
      expect(got.filter((k) => !want.includes(k)), `${name} invents fields`).toEqual([]);
      // Optional members may legitimately be absent from an empty answer; a
      // required one may not, and that is the direction that crashes a screen.
      const required = want.filter(
        (k) => !new RegExp(`\\b${k}\\?\\s*:`).test(type!.startsWith('{') ? type! : API_SRC + SHARED_SRC),
      );
      expect(
        required.filter((k) => !got.includes(k)),
        `${name} omits required fields of ${type}`,
      ).toEqual([]);
    });
  }
});
