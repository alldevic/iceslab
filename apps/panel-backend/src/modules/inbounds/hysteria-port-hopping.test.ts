// The port-hopping range, and the three shapes that used to be accepted.
//
// The schema's own comment said cross-field validation "lives in
// inbounds.service.ts" — and the sentence outlived the file. Slice 27 removed
// the inbound routes and their service with them, so from then until
// 2026-08-29 nothing checked the pair at all. Measured against the live panel,
// every one of these answered 201:
//
//   {start: 50000, end: 20000}   an inverted range
//   {start: 30000}               half a pair
//   {start: 1100,  end: 1200}    a range no node redirects
//
// The first two are refused here. Half a pair is the quiet one and the reason
// this is worth a schema rule rather than a form hint: `buildHysteriaUri` emits
// `mport=` only when BOTH are numbers, so the operator switches port-hopping
// on, the panel answers 201, and every client link goes out without it. Nothing
// anywhere says so — not the response, not the node, not the client.
//
// The THIRD used to be accepted here, and the reason was true when it was
// written: what a node redirects is decided at install time by
// `--hysteria-port-range` (default 20000-50000), the node never told the panel
// which range it installed, and a rule guessing that number would have refused
// a node someone installed with a custom one.
//
// The node reports it now (dto.PortHopDto, read out of its own nat table), so
// the reason is gone and the exception goes with it. It does NOT come back as a
// schema rule, because the schema still cannot know: a profile is saved against
// whatever nodes it is bound to, and two nodes can redirect two different
// ranges. It moved to where the pair is visible - assertPortHoppingFitsNodes,
// covered in profiles.port-hopping.test.ts, which refuses the pair and names
// the node.
//
// So this file keeps asserting that the SCHEMA takes such a range, and that is
// not a leftover: a node that reports nothing is still not judged, and this is
// the case that says the judging never moved into the schema.

import { describe, expect, it } from 'vitest';
import { HysteriaConfigSchema } from './inbounds.schemas.js';
import { buildHysteriaUri } from '../../core-adapters/hysteria/uri.js';

function issues(config: unknown): string[] {
  const r = HysteriaConfigSchema.safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the hysteria port-hopping range', () => {
  it('takes a whole range', () => {
    expect(issues({ portHoppingStart: 20000, portHoppingEnd: 50000 })).toEqual([]);
  });

  it('takes no range at all: the feature is off, which is the default', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ obfsPassword: 'salamander' })).toEqual([]);
  });

  it('refuses half a pair, whichever half', () => {
    // The control this case needs is the CONSEQUENCE, not the count: half a
    // pair does not fail loudly anywhere downstream, it just disappears.
    const uri = buildHysteriaUri({
      host: 'node.example.com',
      port: 443,
      password: 'p',
      name: 'n',
      portHoppingStart: 30000,
    });
    expect(uri, 'the client link carries no mport= for half a pair').not.toContain('mport');

    expect(issues({ portHoppingStart: 30000 })).toHaveLength(1);
    expect(issues({ portHoppingStart: 30000 })[0]).toMatch(/both ends/);
    expect(issues({ portHoppingEnd: 30000 })).toHaveLength(1);
  });

  it('refuses a range that ends where it starts, or below', () => {
    expect(issues({ portHoppingStart: 50000, portHoppingEnd: 20000 })[0]).toMatch(/end above/);
    expect(issues({ portHoppingStart: 30000, portHoppingEnd: 30000 })[0]).toMatch(/end above/);
  });

  it('takes a range the schema alone cannot judge', () => {
    // Whether a node redirects 1100-1200 is a property of that node, and the
    // schema is not looking at one. The refusal lives where the pair is -
    // assertPortHoppingFitsNodes - so this asserts the schema stayed out of it.
    // A node that has never reported a range is still not judged at all.
    expect(issues({ portHoppingStart: 1100, portHoppingEnd: 1200 })).toEqual([]);
  });
});
