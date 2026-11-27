import { describe, expect, it } from 'vitest';
import { backendModuleSources, outsideFrontendFilter } from '@/test-support/backendSource';
import { interfaceFields, interfaceOptionalFields } from '@/test-support/declarations';

/**
 * The interfaces of lib/domain/*.ts are written by hand, as what the backend's
 * mappers return, and nothing held the two together. Rename a field in a
 * mapper and this side keeps compiling: the property is `undefined` at runtime,
 * the column renders blank, and no error is raised anywhere.
 *
 * Both sides are read as text (the frontend takes no backend module) and
 * compared by the names of their top-level fields. Types and nested objects are
 * not compared; that limit is deliberate.
 */

const FRONT = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The source of `lib/domain/*.ts` that declares `export interface <name>`. */
function frontSource(name: string): string {
  const re = new RegExp(`^export interface ${name}\\b`, 'm');
  const hit = Object.values(FRONT).find((src) => re.test(src));
  if (!hit) throw new Error(`export interface ${name} not found in lib/domain`);
  return hit;
}

interface Pair {
  /** The interface lib/domain declares. */
  front: string;
  /** The DTO the backend declares, and the file (under modules/) it lives in. */
  back: string;
  file: string;
  /**
   * Fields the backend sends that this UI deliberately does not declare. Extra
   * on the wire is harmless, so this direction is a ledger, not a failure; a
   * new entry is a decision to take, not a diff to skim past.
   */
  backendOnly?: Record<string, string>;
  /**
   * Fields this UI declares that the backend does not send. This is the
   * direction that costs (a field the API never sends is `undefined`), so an
   * entry has to be optional in lib/domain and carry its reason.
   */
  frontOnly?: Record<string, string>;
}

const PAIRS: Pair[] = [
  {
    front: 'User',
    back: 'PublicUserDto',
    file: 'users/users.mapper.ts',
    backendOnly: {
      numericId: 'the compatibility facade\'s stable handle for a user; the admin UI has no column for it',
      externalSquadUuid: 'echoed back verbatim to the facade\'s storefront; the admin UI never shows it',
    },
  },
  {
    front: 'Node',
    back: 'PublicNodeDto',
    file: 'nodes/nodes.mapper.ts',
  },
  { front: 'NodeSyncStatus', back: 'NodeSyncStatusDto', file: 'nodes/nodes.sync-status.ts' },
  { front: 'NodeHardening', back: 'HardeningDto', file: 'nodes/nodes.mapper.ts' },
  { front: 'NodeWithPayload', back: 'CreateNodeResponseDto', file: 'nodes/nodes.mapper.ts' },
  { front: 'Profile', back: 'PublicProfileDto', file: 'profiles/profiles.mapper.ts' },
  {
    front: 'Binding',
    back: 'PublicBindingDto',
    file: 'profiles/profiles.mapper.ts',
    backendOnly: {
      rendersProfile: 'optional on the wire and shown nowhere yet; it only gates creating and editing a pair',
    },
  },
  { front: 'ProfileKeyImpact', back: 'ProfileKeyImpactDto', file: 'profiles/profiles.key-impact.ts' },
  { front: 'Squad', back: 'PublicSquadDto', file: 'squads/squads.mapper.ts' },
  { front: 'Host', back: 'PublicHostDto', file: 'hosts/hosts.mapper.ts' },
  { front: 'HostFreshness', back: 'HostFreshnessDto', file: 'hosts/hosts.freshness.ts' },
  {
    front: 'RoutePolicy',
    back: 'PublicRoutePolicyDto',
    file: 'route-policies/route-policies.routes.ts',
    frontOnly: {
      rules: 'optional placeholder for the ordered rule list; the API answers with the two flat domain arrays',
    },
  },
  { front: 'NodePolicy', back: 'NodePolicyDto', file: 'node-policies/node-policies.mapper.ts' },
  { front: 'PolicyRule', back: 'PolicyRuleDto', file: 'node-policies/node-policies.mapper.ts' },
  { front: 'ApiToken', back: 'PublicApiTokenDto', file: 'api-tokens/api-tokens.service.ts' },
  {
    front: 'Cascade',
    back: 'CascadeDto',
    file: 'cascades/cascade.mapper.ts',
    frontOnly: {
      lineRenames: 'only in the answer to a save (CascadeSaveResult), not in the DTO every read renders',
    },
  },
  { front: 'CascadeHop', back: 'CascadeHopDto', file: 'cascades/cascade.mapper.ts' },
  { front: 'CascadePosition', back: 'CascadePositionDto', file: 'cascades/cascade.mapper.ts' },
  { front: 'CascadeDirection', back: 'CascadeDirectionDto', file: 'cascades/cascade.mapper.ts' },
  { front: 'CascadeTunnel', back: 'CascadeTunnelDto', file: 'cascades/cascade.mapper.ts' },
  { front: 'CascadeStatus', back: 'CascadeStatusDto', file: 'cascades/cascade.service.ts' },
];

/** DTOs with no interface here, each with the reason. */
const UNPAIRED: Record<string, string> = {
  PublicAdminDto:
    'the admin screens never list admins; the only consumer of /api/admin is the first-run ' +
    'bootstrap, which reads nothing off the response',
  UserDeliveryDto:
    'GET /api/users/:id/delivery is read as `unknown` and narrowed field by field by ' +
    'deliveryRouting() in users.ts, so there is no interface to drift',
};

const SOURCES = backendModuleSources();
const backFields = (p: Pair) => interfaceFields(SOURCES[p.file] ?? '', p.back);

describe.each(PAIRS)('$front <-> $back', (p) => {
  // Read inside the cases, not while collecting them: a mapper that moved
  // throws, and a throw during collection takes every other pair down with it.
  const read = () => {
    if (!SOURCES[p.file]) throw new Error(`${p.file} is not under panel-backend/src/modules`);
    return { front: interfaceFields(frontSource(p.front), p.front), back: backFields(p) };
  };

  it('both sides parsed to something recognisable', () => {
    const f = read();
    expect(f.front.length).toBeGreaterThan(0);
    expect(f.back.length).toBeGreaterThan(0);
    expect(
      f.front.filter((n) => f.back.includes(n)),
      `${p.front} and ${p.back} share no field name; one of the two did not parse`,
    ).not.toEqual([]);
  });

  it('asks for nothing the backend does not send', () => {
    const f = read();
    const missing = f.front.filter((n) => !f.back.includes(n));
    expect(missing.sort(), `${p.front} declares fields ${p.back} does not return`).toEqual(
      Object.keys(p.frontOnly ?? {}).sort(),
    );
    const optional = interfaceOptionalFields(frontSource(p.front), p.front);
    for (const n of Object.keys(p.frontOnly ?? {})) expect(optional, `${p.front}.${n} must be optional`).toContain(n);
  });

  it('declares every field the backend sends, except the listed ones', () => {
    const f = read();
    const undeclared = f.back.filter((n) => !f.front.includes(n));
    expect(undeclared.sort(), `${p.back} returns fields ${p.front} does not declare`).toEqual(
      Object.keys(p.backendOnly ?? {}).sort(),
    );
  });
});

// A mirror that covers a third of its subject reads exactly like one that
// covers all of it, so the table is checked against the backend on disk: a DTO
// is any `export interface <name>Dto` under panel-backend/src/modules.
describe('every DTO the backend declares is accounted for', () => {
  const dtoFiles = new Map<string, string[]>();
  for (const [file, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/^export interface\s+([A-Za-z0-9_]*Dto)\b/gm)) {
      dtoFiles.set(m[1]!, [...(dtoFiles.get(m[1]!) ?? []), file]);
    }
  }
  const found = [...dtoFiles.keys()].sort();

  it('finds the DTOs at all', () => {
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain('PublicUserDto');
  });

  it('pairs each of them with an interface here, or names why it cannot be', () => {
    const covered = new Set([...PAIRS.map((p) => p.back), ...Object.keys(UNPAIRED)]);
    expect(
      found.filter((d) => !covered.has(d)),
      'add a pair to PAIRS, or a reason to UNPAIRED',
    ).toEqual([]);
  });

  it('names nothing that is gone, and every pair points at the file that declares its DTO', () => {
    const declared = [...PAIRS.map((p) => p.back), ...Object.keys(UNPAIRED)];
    expect(declared.filter((d) => !found.includes(d))).toEqual([]);
    for (const p of PAIRS) expect(dtoFiles.get(p.back), p.back).toContain(p.file);
  });

  it('every file that declares a DTO starts the frontend CI job when edited', () => {
    expect(
      outsideFrontendFilter([...dtoFiles.values()].flat()),
      'add the file to the `frontend` filter of the `changes` job in .github/workflows/ci.yml',
    ).toEqual([]);
  });
});
