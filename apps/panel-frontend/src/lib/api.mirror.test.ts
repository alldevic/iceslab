import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `api.ts` is 2261 lines of hand-written interfaces standing in for whatever
 * the backend actually returns, and nothing held the two together. Rename a
 * field in a mapper and this side keeps compiling: the property is simply
 * `undefined` at runtime, the column renders blank, and no error is raised
 * anywhere — not in the build, not in the types, not in the request. The same
 * shape of scar as the panel↔node wire, which is now held by
 * `apps/node/internal/dto/wire_test.go` reading `transport.ts`; this is the
 * same instrument pointed at the other seam.
 *
 * Read off the source rather than a captured sample, because a sample only
 * proves what one endpoint answered once. The mappers are the declaration:
 * every REST response for these five types goes through them.
 */

const FRONT = join(import.meta.dirname, 'api.ts');
const BACK = join(import.meta.dirname, '..', '..', '..', 'panel-backend', 'src', 'modules');

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

// ───── The parser's own control ─────
//
// Without this the comparisons below could pass on emptiness — exactly the
// hole `wire_test.go` had. The fixture carries every shape the two real files
// use, plus the two that would fool a line-based reader.
describe('interfaceFields', () => {
  const FIXTURE = `
export interface Sample {
  id: string;
  /** A doc comment mentioning notAField: string; which is prose, not a member. */
  name: string | null;
  // notAField: number;
  nested?: { inner: string; deeper: { x: number } };
  union: 'a' | 'b' | 'c';
  list: Array<{ k: string }>;
  fn: (arg: string) => void;
  multi: {
    across: string;
    lines: number;
  };
  last: boolean
}

export interface Other {
  decoy: string;
}
`;

  it('reads the top-level members and nothing else', () => {
    expect(interfaceFields(FIXTURE, 'Sample')).toEqual([
      'id',
      'name',
      'nested',
      'union',
      'list',
      'fn',
      'multi',
      'last',
    ]);
  });

  it('stops at the closing brace instead of running into the next interface', () => {
    expect(interfaceFields(FIXTURE, 'Sample')).not.toContain('decoy');
  });

  it('throws rather than returning nothing when the interface is gone', () => {
    expect(() => interfaceFields(FIXTURE, 'Missing')).toThrow(/not found/);
  });
});

// ───── The five pairs ─────

interface Pair {
  /** The interface `api.ts` declares. */
  front: string;
  /** The DTO the backend mapper declares, and the file it lives in. */
  back: string;
  mapper: string;
  /**
   * Fields the backend sends that this UI deliberately does not declare.
   *
   * Extra on the wire is harmless — JSON the client never reads — so this
   * direction is a ledger, not a failure. It is pinned all the same: a NEW
   * entry appearing means someone added a field the admin screens cannot
   * show, and that is a decision to take rather than a diff to skim past.
   */
  backendOnly: string[];
}

const PAIRS: Pair[] = [
  {
    front: 'User',
    back: 'PublicUserDto',
    mapper: 'users/users.mapper.ts',
    // Both exist because the Remnawave-compat facade needed them; the admin UI
    // has no column for either. `numericId` is the storefront's stable handle
    // for a user, `externalSquadUuid` is echoed back to it verbatim.
    backendOnly: ['numericId', 'externalSquadUuid'],
  },
  { front: 'Node', back: 'PublicNodeDto', mapper: 'nodes/nodes.mapper.ts', backendOnly: [] },
  {
    front: 'Profile',
    back: 'PublicProfileDto',
    mapper: 'profiles/profiles.mapper.ts',
    backendOnly: [],
  },
  { front: 'Squad', back: 'PublicSquadDto', mapper: 'squads/squads.mapper.ts', backendOnly: [] },
  { front: 'Host', back: 'PublicHostDto', mapper: 'hosts/hosts.mapper.ts', backendOnly: [] },
];

const frontSrc = readFileSync(FRONT, 'utf8');

describe.each(PAIRS)('$front ↔ $back', ({ front, back, mapper, backendOnly }) => {
  // Read inside the cases, not while collecting them: a mapper that moved
  // throws, and a throw during collection takes the whole file down — every
  // other pair included — reported as "no tests" rather than as the one thing
  // that broke.
  const read = () => ({
    front: interfaceFields(frontSrc, front),
    back: interfaceFields(readFileSync(join(BACK, mapper), 'utf8'), back),
  });

  it('both sides parsed to something recognisable', () => {
    const fields = read();
    // The control again, this time on the real files: a mapper that moved, or
    // a shape this parser cannot read, must fail loudly here rather than make
    // the two comparisons below trivially true.
    expect(fields.front.length).toBeGreaterThan(5);
    expect(fields.back.length).toBeGreaterThan(5);
    expect(fields.front).toContain('id');
    expect(fields.back).toContain('id');
  });

  it('asks for nothing the backend does not send', () => {
    const fields = read();
    // The direction that costs: a field named here and not there arrives as
    // `undefined`, and the screen shows an empty cell with no error anywhere.
    const missing = fields.front.filter((f) => !fields.back.includes(f));
    expect(missing, `${front} declares fields ${back} does not return`).toEqual([]);
  });

  it('declares every field the backend sends, except the pinned ones', () => {
    const fields = read();
    const undeclared = fields.back.filter((f) => !fields.front.includes(f));
    expect(undeclared.sort()).toEqual([...backendOnly].sort());
  });
});
