import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateProfileSchema, ListProfilesQuerySchema, ProtocolEnum } from './profiles.schemas';
import { PROTOCOL_CONFIG_SCHEMAS } from '../inbounds/inbounds.schemas';

/**
 * Which protocols a profile may be — asked of the API, against every other
 * list in the repo that answers the same question.
 *
 * There are five of them: the ProtocolName union in `packages/shared`, the
 * PROTOCOL_CONFIG_SCHEMAS map, ListInboundsQuerySchema, the frontend's
 * PROFILE_KINDS, and the discriminated union under CreateProfileSchema. Four
 * had eleven protocols and the fifth had eight: `tuic`, `anytls` and
 * `shadowtls` were missing from the profile union and from ProtocolEnum.
 *
 * Nothing said so. The profile form offered all three under its "sing-box"
 * group, the node registered a sing-box adapter for each, the subscription
 * formats emitted them, their config schemas were written and exported — and
 * `POST /api/profiles` answered a Zod union error, so no profile for any of
 * the three could be created at all. Since the inbound routes were removed in
 * slice 27, that was the only door.
 *
 * The lists are read, not restated: a sixth copy is not the fix.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSPORT = resolve(HERE, '../../../../../packages/shared/src/transport.ts');
const FORM = resolve(HERE, '../../../../panel-frontend/src/components/ProfileFormModal.tsx');

function sharedProtocolUnion(): string[] {
  const src = readFileSync(TRANSPORT, 'utf8');
  const at = src.indexOf('export type ProtocolName =');
  expect(at, 'the ProtocolName union was renamed or moved').toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf(';', at));
  const names = [...body.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]!);
  expect(names.length, 'the union parsed to almost nothing').toBeGreaterThan(7);
  return names.sort();
}

/** The protocols the profile form lets an operator pick. */
function formProtocols(): string[] {
  const src = readFileSync(FORM, 'utf8');
  const at = src.indexOf('const PROFILE_KINDS');
  expect(at, 'PROFILE_KINDS was renamed or moved in the form').toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('\n];', at));
  const names = [...body.matchAll(/protocol: '([a-z0-9]+)'/g)].map((m) => m[1]!);
  expect(names.length, 'PROFILE_KINDS parsed to almost nothing').toBeGreaterThan(7);
  return [...new Set(names)].sort();
}

describe('the protocols a profile may be', () => {
  const shared = sharedProtocolUnion();

  it('ProtocolEnum is the shared union', () => {
    expect([...ProtocolEnum.options].sort()).toEqual(shared);
  });

  it('every shared protocol has a config schema', () => {
    expect(Object.keys(PROTOCOL_CONFIG_SCHEMAS).sort()).toEqual(shared);
  });

  it('every shared protocol reaches a branch of the create union', () => {
    // The union under CreateProfileSchema is the door. A missing branch and an
    // incomplete config both fail the parse, and they are not the same thing:
    // a config missing `subnet` is the schema working, a discriminator that
    // matched nothing is the protocol having no door at all. The two are told
    // apart by where the issue lands — `['protocol']` with code invalid_union
    // is the door, anything under `['config', ...]` is the room behind it.
    // So an empty config is enough to ask this question of all eleven without
    // inventing a valid config for each.
    const doorless = shared.filter((protocol) => {
      const r = CreateProfileSchema.safeParse({ name: `probe-${protocol}`, protocol, config: {} });
      if (r.success) return false;
      return r.error.issues.some((i) => i.code === 'invalid_union' && i.path[0] === 'protocol');
    });
    expect(doorless, 'protocols the whole stack supports and the create union has no branch for').toEqual([]);
  });

  it('every shared protocol can be filtered for', () => {
    const refused = shared.filter((p) => !ListProfilesQuerySchema.safeParse({ protocol: p }).success);
    expect(refused, 'protocols whose list filter answers 400').toEqual([]);
  });

  it('the form offers nothing the API will refuse', () => {
    // The direction that actually reached an operator: a kind in the dropdown
    // with no branch behind it is a wizard that ends in a union error.
    expect(formProtocols()).toEqual(shared);
  });

  it('a protocol that is not a protocol is still refused, at the door', () => {
    // The control, and it is the one that makes the case above mean something:
    // the marker it looks for has to actually appear when a branch is missing.
    const r = CreateProfileSchema.safeParse({ name: 'x', protocol: 'nope', config: {} });
    expect(r.success).toBe(false);
    expect(
      !r.success && r.error.issues.some((i) => i.code === 'invalid_union' && i.path[0] === 'protocol'),
      'a missing branch must be recognisable, or the doorless check above is vacuous',
    ).toBe(true);
    expect(ListProfilesQuerySchema.safeParse({ protocol: 'nope' }).success).toBe(false);
  });
});
