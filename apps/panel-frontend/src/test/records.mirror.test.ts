import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceFields, interfaceOptionalFields } from './declarations';
import {
  aBinding,
  aCascade,
  aDevice,
  aHost,
  aNode,
  aProfile,
  aRegion,
  aRoutePolicy,
  aRoutingPreset,
  aSquad,
  aUser,
} from './records';

/**
 * The record fixtures, held to the interfaces they stand in for.
 *
 * A fixture that omits a field does not fail — the component reads
 * `undefined`, renders a blank cell, and the test that mounted it reports a
 * pass. That is the failure this file exists to make loud, and the direction
 * that costs: an INVENTED field is only clutter, a MISSING required one is a
 * test agreeing with a screen about something neither of them checked.
 */

const API = readFileSync(join(import.meta.dirname, '..', 'lib', 'api.ts'), 'utf8');

const PAIRS: [string, string, object][] = [
  ['aNode', 'Node', aNode()],
  ['aProfile', 'Profile', aProfile()],
  ['aBinding', 'Binding', aBinding()],
  ['aHost', 'Host', aHost()],
  ['aSquad', 'Squad', aSquad()],
  ['aUser', 'User', aUser()],
  ['aCascade', 'Cascade', aCascade()],
  ['aRoutePolicy', 'RoutePolicy', aRoutePolicy()],
  ['aRoutingPreset', 'RoutingPreset', aRoutingPreset()],
  ['aRegion', 'Region', aRegion()],
  ['aDevice', 'HwidDevice', aDevice()],
];

describe.each(PAIRS)('%s ↔ %s', (factory, type, record) => {
  const declared = interfaceFields(API, type);
  const optional = interfaceOptionalFields(API, type);

  it('the interface parsed to something', () => {
    // The control: an interface that resolved to nothing would make both
    // comparisons below true of any fixture at all.
    expect(declared.length, `${type} resolved to no fields`).toBeGreaterThan(2);
  });

  it('carries every required field', () => {
    const missing = declared.filter((f) => !optional.includes(f) && !(f in record));
    expect(missing, `${factory}() omits required fields of ${type}`).toEqual([]);
  });

  it('and invents none', () => {
    const extra = Object.keys(record).filter((f) => !declared.includes(f));
    expect(extra, `${factory}() sets fields ${type} does not declare`).toEqual([]);
  });
});
