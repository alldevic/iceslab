/**
 * Source-level declaration parsing, shared by the mirror tests.
 *
 * It lives here rather than beside one of them because importing a symbol from
 * a `.test.ts` file re-runs that file's entire suite inside the importer: the
 * settings mirror was reporting twenty-three cases, twenty of which belonged to
 * api.mirror.test.ts.
 */

/** Comments hold field-shaped text all over both files, so they go first. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Top-level property names of one interface, in declaration order.
 *
 * Depth-aware on purpose: `reach?: { squads: number; users: number }` is one
 * field named `reach`, not three. Throws when the interface is not there,
 * which is the failure this whole file exists to avoid — a comparison that
 * passes because one side parsed to nothing.
 */
export function interfaceFields(src: string, name: string): string[] {
  const header = new RegExp(`\\binterface\\s+${name}\\s*(?:extends\\s+[^{]+)?\\{`);
  const clean = stripComments(src);
  const at = clean.search(header);
  if (at < 0) throw new Error(`interface ${name} not found`);
  const open = clean.indexOf('{', at);

  const fields: string[] = [];
  let depth = 0;
  let member = '';
  for (let i = open; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) break; // closed the interface
    }
    if (depth === 1 && (ch === ';' || ch === ',' || ch === '\n')) {
      // A member ends at a top-level separator. Newline counts too: an
      // interface whose last member has no semicolon is still legal TS.
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(member);
      if (m) fields.push(m[1]!);
      member = '';
    } else if (depth >= 1 && i > open) {
      member += ch;
    }
  }
  return fields;
}
