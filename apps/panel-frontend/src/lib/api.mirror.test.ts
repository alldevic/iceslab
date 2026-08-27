import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceFields } from '../test/declarations';

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
  generic: Record<string, unknown> | null;
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
      // Angle brackets are not tracked, so the comma inside Record<> ends the
      // member early. Harmless — the NAME is read off the front of the segment
      // and the tail matches nothing — and pinned here so it stays a known
      // limit rather than a surprise in the next type that has one.
      'generic',
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

// ───── The pairs ─────

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
  /**
   * Fields this UI declares that the backend does not send, each one a
   * deliberate placeholder. Unlike `backendOnly` this direction is the one
   * that costs — a field the API never sends is `undefined` at runtime — so an
   * entry here has to be optional in `api.ts` AND carry the reason in its own
   * doc comment. Empty for every pair but one.
   */
  frontOnly?: string[];
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
  {
    front: 'RoutePolicy',
    back: 'PublicRoutePolicyDto',
    mapper: 'route-policies/route-policies.routes.ts',
    backendOnly: [],
    // Declared optional and documented in api.ts as "the API does not ship it
    // yet": the editor works in an ordered rule list and derives one from the
    // two flat domain arrays. Pinned here so the day the backend starts
    // storing rules, the removal of the placeholder is a decision and not a
    // silent drift.
    frontOnly: ['rules'],
  },
  {
    front: 'Binding',
    back: 'PublicBindingDto',
    mapper: 'profiles/profiles.mapper.ts',
    backendOnly: [],
  },
  {
    front: 'ApiToken',
    back: 'PublicApiTokenDto',
    mapper: 'api-tokens/api-tokens.service.ts',
    backendOnly: [],
  },
  { front: 'Cascade', back: 'CascadeDto', mapper: 'cascades/cascade.mapper.ts', backendOnly: [] },
  {
    front: 'CascadeHop',
    back: 'CascadeHopDto',
    mapper: 'cascades/cascade.mapper.ts',
    backendOnly: [],
  },
  {
    front: 'CascadePosition',
    back: 'CascadePositionDto',
    mapper: 'cascades/cascade.mapper.ts',
    backendOnly: [],
  },
  {
    front: 'CascadeDirection',
    back: 'CascadeDirectionDto',
    mapper: 'cascades/cascade.mapper.ts',
    backendOnly: [],
  },
  {
    front: 'CascadeStatus',
    back: 'CascadeStatusDto',
    mapper: 'cascades/cascade.service.ts',
    backendOnly: [],
  },
  {
    front: 'NodeHardening',
    back: 'HardeningDto',
    mapper: 'nodes/nodes.mapper.ts',
    backendOnly: [],
  },
  {
    front: 'NodeWithPayload',
    back: 'CreateNodeResponseDto',
    mapper: 'nodes/nodes.mapper.ts',
    backendOnly: [],
  },
];

/**
 * DTOs with nothing to compare them to, named so that "not in the table" and
 * "deliberately unpaired" stay different states.
 */
const UNPAIRED: Record<string, string> = {
  PublicAdminDto:
    'the admin screens never list admins; the only consumer of /api/admin is the ' +
    'first-run bootstrap, which reads nothing off the response',
};

const frontSrc = readFileSync(FRONT, 'utf8');

describe.each(PAIRS)('$front ↔ $back', ({ front, back, mapper, backendOnly, frontOnly }) => {
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
    //
    // Not `toContain('id')` any more: the table now holds the nested shapes
    // too (a cascade hop, a hardening block, the create-node envelope) and
    // several of those legitimately have no id. The overlap is the stronger
    // control anyway — two lists that share nothing is what a side parsed to
    // garbage looks like, whatever the field names are.
    expect(fields.front.length).toBeGreaterThan(1);
    expect(fields.back.length).toBeGreaterThan(1);
    expect(
      fields.front.filter((f) => fields.back.includes(f)),
      `${front} and ${back} share no field name at all; one of the two did not parse`,
    ).not.toEqual([]);
  });

  it('asks for nothing the backend does not send', () => {
    const fields = read();
    // The direction that costs: a field named here and not there arrives as
    // `undefined`, and the screen shows an empty cell with no error anywhere.
    const missing = fields.front.filter((f) => !fields.back.includes(f));
    expect(missing.sort(), `${front} declares fields ${back} does not return`).toEqual(
      [...(frontOnly ?? [])].sort(),
    );
  });

  it('declares every field the backend sends, except the pinned ones', () => {
    const fields = read();
    const undeclared = fields.back.filter((f) => !fields.front.includes(f));
    expect(undeclared.sort()).toEqual([...backendOnly].sort());
  });
});

// ───── The control on the list itself ─────
//
// This table compared five pairs while sixteen DTOs existed. Nothing said so:
// a mirror that covers a third of its subject reads exactly like one that
// covers all of it, and the eleven outside it included every nested shape the
// cascade screens render. So the list is checked against the backend on disk,
// mechanically — a DTO is any `export interface <name>Dto` under
// panel-backend/src/modules — and a new one has to be paired or named unpaired
// before this file goes green again.
describe('every DTO the backend declares is accounted for', () => {
  function dtoNames(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...dtoNames(full));
        continue;
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
      for (const m of readFileSync(full, 'utf8').matchAll(
        /^export interface\s+([A-Za-z0-9_]*Dto)\b/gm,
      )) {
        out.push(m[1]!);
      }
    }
    return out;
  }

  const found = [...new Set(dtoNames(BACK))].sort();

  it('finds the DTOs at all', () => {
    // The control's own control: an empty scan would make the comparison below
    // vacuous, and "found nothing" is also what a moved directory looks like.
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain('PublicUserDto');
  });

  it('pairs each of them with an interface here, or names why it cannot be', () => {
    const covered = new Set([...PAIRS.map((p) => p.back), ...Object.keys(UNPAIRED)]);
    expect(
      found.filter((d) => !covered.has(d)),
      'add a pair to PAIRS, or a reason to UNPAIRED. A DTO outside this file is one ' +
        'whose fields agree with nothing on this side.',
    ).toEqual([]);
  });

  it('and names nothing that is gone', () => {
    // The other direction: a pair or an exemption whose DTO no longer exists
    // keeps passing forever against a shape nobody ships.
    const declared = [...PAIRS.map((p) => p.back), ...Object.keys(UNPAIRED)].sort();
    expect(declared.filter((d) => !found.includes(d))).toEqual([]);
  });
});
