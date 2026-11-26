/**
 * Source-level declaration parsing for the mirror tests (milestone 17.2).
 *
 * It is a module of its own, not a helper inside one of the tests: importing a
 * symbol from a `.test.ts` file re-runs that file's whole suite in the
 * importer. Everything here throws on a shape it does not recognise rather than
 * returning an empty list: a comparison that passes because one side parsed to
 * nothing is the failure the mirrors exist to prevent.
 */

/** Comments hold field-shaped text all over the sources, so they go first. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

interface Member {
  name: string;
  optional: boolean;
}

/**
 * The members of the `{ … }` block opening at `open`, at depth one. A member
 * ends at a top-level `;`, `,` or newline (the last member of an interface may
 * have no semicolon), and the NAME is read off the front of the segment.
 * `<` and `>` are not tracked, so a comma inside `Record<K, V>` ends a member
 * early; the tail then matches nothing, which is harmless.
 */
function blockMembers(clean: string, open: number): Member[] {
  const out: Member[] = [];
  let depth = 0;
  let member = '';
  const flush = () => {
    const m = /^\s*(?:readonly\s+)?(?:['"]?)([A-Za-z_$][\w$-]*)(?:['"]?)\s*(\??)\s*:/.exec(member);
    if (m) out.push({ name: m[1]!, optional: m[2] === '?' });
    member = '';
  };
  for (let i = open; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        flush();
        return out;
      }
    }
    if (depth === 1 && (ch === ';' || ch === ',' || ch === '\n')) flush();
    else if (depth >= 1 && i > open) member += ch;
  }
  throw new Error('unterminated block');
}

function interfaceMembers(src: string, name: string): Member[] {
  const header = new RegExp(`\\binterface\\s+${name}\\b\\s*(?:extends\\s+[^{]+)?\\{`);
  const clean = stripComments(src);
  const at = clean.search(header);
  if (at < 0) throw new Error(`interface ${name} not found`);
  return blockMembers(clean, clean.indexOf('{', at));
}

/** Top-level property names of one interface, in declaration order. Throws when it is not there. */
export function interfaceFields(src: string, name: string): string[] {
  return interfaceMembers(src, name).map((m) => m.name);
}

/** Names of the members declared optional (`foo?: T`), off the same scan as `interfaceFields`. */
export function interfaceOptionalFields(src: string, name: string): string[] {
  return interfaceMembers(src, name)
    .filter((m) => m.optional)
    .map((m) => m.name);
}

/** The names an interface lists after `extends`, `[]` when it has none. Throws when it is not there. */
export function interfaceParents(src: string, name: string): string[] {
  const clean = stripComments(src);
  const m = new RegExp(`\\binterface\\s+${name}\\b\\s*(?:extends\\s+([^{]+))?\\{`).exec(clean);
  if (!m) throw new Error(`interface ${name} not found`);
  return (m[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/<.*$/, ''))
    .filter(Boolean);
}

/**
 * Top-level keys of the zod object literal in `export const <name> = z.object({ … })`
 * (or `const <name> = …`). Throws when the constant, the `z.object(` or the
 * literal is not there.
 */
export function zodObjectKeys(src: string, name: string): string[] {
  const clean = stripComments(src);
  const at = clean.search(new RegExp(`\\bconst\\s+${name}\\s*=\\s*z\\.object\\(\\s*\\{`));
  if (at < 0) throw new Error(`z.object constant ${name} not found`);
  const keys = blockMembers(clean, clean.indexOf('{', clean.indexOf('z.object(', at))).map((m) => m.name);
  if (keys.length === 0) throw new Error(`z.object constant ${name} parsed to no keys`);
  return [...new Set(keys)];
}
