import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_HOPS,
  MAX_LINKS,
  LINK_PROTOCOL_VALUES,
  isKnownProtocol,
  protocolOptions,
  roleAt,
  carriesLinkAt,
  toHopInputs,
} from './CascadeEditor';
import { MAX_CASCADE_LINKS } from '@iceslab/shared';

/**
 * The decisions inside the cascade editor, and the three ceilings it says it
 * mirrors.
 *
 * 1935 lines with no test of any kind, but the part that decides what gets
 * SENT is a handful of pure functions: which hop is the entry, which hops carry
 * a link, and what shape the API is handed. Getting those wrong is not a
 * rendering problem — a link protocol on a hop that does not carry one, or a
 * missing one on a hop that does, is a cascade that saves and does not forward.
 *
 * Alongside them, three constants whose comments say they mirror the backend
 * and which nothing compared: MAX_HOPS against MAX_CASCADE_HOPS, MAX_LINKS
 * against MAX_CASCADE_LINKS, and the seven link protocols against
 * CascadeProtocol. MAX_LINKS stopped being a mirror on 2026-08-27 and became
 * the same symbol, because mirroring the ceiling had left the two sides
 * counting links by two different formulas (§49.3). That contract has already been wrong once in this repo, in
 * the direction that costs most: the profile form offered three protocols the
 * API had no branch for, and nothing said so until a save failed.
 */

const SCHEMAS = join(
  import.meta.dirname,
  '..', '..', '..', 'panel-backend', 'src', 'modules', 'cascades', 'cascade.schemas.ts',
);

function backendNumber(name: string): number {
  const src = readFileSync(SCHEMAS, 'utf8');
  const m = src.match(new RegExp(`export const ${name} = (\\d+);`));
  expect(m, `${name} was renamed or moved in cascade.schemas.ts`).not.toBeNull();
  return Number(m![1]);
}

function backendProtocols(): string[] {
  const src = readFileSync(SCHEMAS, 'utf8');
  const at = src.indexOf('export const CascadeProtocol = z.enum([');
  expect(at, 'CascadeProtocol was renamed or moved').toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf(']', at));
  const names = [...body.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]!);
  expect(names.length, 'the enum parsed to almost nothing').toBeGreaterThan(3);
  return names.sort();
}

describe('the ceilings the editor says it mirrors', () => {
  it('allows exactly as many hops as the API stores', () => {
    // One more here than the schema takes is a wizard that lets an operator
    // build a fifth hop and refuses it on save; one fewer is a cascade shape
    // the product supports and nobody can draw.
    expect(MAX_HOPS).toBe(backendNumber('MAX_CASCADE_HOPS'));
  });

  it('allows exactly as many links as the API stores, because it is the same symbol', () => {
    // This used to read the number out of cascade.schemas.ts, and that is how
    // it caught the change below: MAX_CASCADE_LINKS is no longer declared
    // there, it is re-exported from `shared`. Mirroring a number was never the
    // hard part — the two sides also needed the same ARITHMETIC, and they had
    // two (§49.3), so the counter and the ceiling both moved to shared. There
    // is nothing left to compare: this asserts they are one value.
    expect(MAX_LINKS).toBe(MAX_CASCADE_LINKS);
    // And that the API side really takes it from there rather than keeping a
    // second declaration that happens to say 64.
    const schemas = readFileSync(SCHEMAS, 'utf8');
    expect(schemas, 'the schema declares its own cap again').not.toMatch(
      /^export const MAX_CASCADE_LINKS = \d+;/m,
    );
    expect(schemas).toContain("import { MAX_CASCADE_LINKS } from '@iceslab/shared'");
  });

  it('offers exactly the protocols a cascade link may speak', () => {
    // Deliberately narrower than the node protocol enum: tuic, anytls and
    // shadowtls are node protocols and not cascade links. That narrowing lives
    // on the backend too, so the two lists must be the same list.
    expect([...LINK_PROTOCOL_VALUES].sort()).toEqual(backendProtocols());
  });
});

describe('which hop is what', () => {
  it('reads a chain as entry, transits, exit', () => {
    const roles = [0, 1, 2, 3].map((i) => roleAt(i, 4, 'chain'));
    expect(roles).toEqual(['entry', 'transit', 'transit', 'exit']);
  });

  it('reads a balancer as one entry and parallel exits', () => {
    const roles = [0, 1, 2, 3].map((i) => roleAt(i, 4, 'balancer'));
    expect(roles).toEqual(['entry', 'exit', 'exit', 'exit']);
  });

  it('has no transit in a two-hop chain', () => {
    expect([0, 1].map((i) => roleAt(i, 2, 'chain'))).toEqual(['entry', 'exit']);
  });
});

describe('which hop carries a link', () => {
  it('gives every hop but the last one a link in a chain', () => {
    expect([0, 1, 2, 3].map((i) => carriesLinkAt(i, 4, 'chain'))).toEqual([true, true, true, false]);
  });

  it('gives only the entry a link in a balancer', () => {
    expect([0, 1, 2, 3].map((i) => carriesLinkAt(i, 4, 'balancer'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  /**
   * The invariant the two functions have to agree on, stated once rather than
   * as a third copy of either: an exit is the end of a path and forwards to
   * nothing, so no hop is ever both an exit and a link carrier — except the
   * balancer's entry, which is an entry, not an exit.
   */
  it('never asks an exit to forward', () => {
    for (const mode of ['chain', 'balancer'] as const) {
      for (let count = 2; count <= MAX_HOPS; count++) {
        for (let i = 0; i < count; i++) {
          if (roleAt(i, count, mode) === 'exit' && carriesLinkAt(i, count, mode)) {
            throw new Error(`${mode}: hop ${i} of ${count} is an exit and carries a link`);
          }
        }
      }
    }
  });
});

describe('what the API is handed', () => {
  const hops = [0, 1, 2].map((k) => ({
    key: k,
    nodeId: `node-${k}`,
    entryProtocol: 'xray' as const,
    linkProtocol: 'shadowsocks' as const,
  }));

  it('puts an entry protocol on the entry and nowhere else', () => {
    const out = toHopInputs(hops, 'chain');
    expect(out[0]).toHaveProperty('entryProtocol', 'xray');
    expect(out[1]).not.toHaveProperty('entryProtocol');
    expect(out[2]).not.toHaveProperty('entryProtocol');
  });

  it('puts a link protocol only where the role carries one', () => {
    // A link protocol on the exit is a field the API has no use for; a missing
    // one on a forwarding hop is a cascade that saves and does not forward.
    const chain = toHopInputs(hops, 'chain');
    expect(chain.map((h) => 'linkProtocol' in h)).toEqual([true, true, false]);

    const balancer = toHopInputs(hops, 'balancer');
    expect(balancer.map((h) => 'linkProtocol' in h)).toEqual([true, false, false]);
  });

  it('numbers the positions contiguously from zero, which is what the schema requires', () => {
    expect(toHopInputs(hops, 'chain').map((h) => h.position)).toEqual([0, 1, 2]);
  });
});

describe('a protocol the database holds and the API would refuse', () => {
  it('recognises the seven it accepts', () => {
    for (const p of LINK_PROTOCOL_VALUES) expect(isKnownProtocol(p)).toBe(true);
  });

  it('refuses what it does not, including nothing at all', () => {
    // `vless` is what the demo seed writes into these columns, which are free
    // strings in the database — so an unknown value is a real state, not a
    // hypothetical one.
    for (const p of ['vless', 'tuic', 'anytls', '', null, undefined]) {
      expect(isKnownProtocol(p as string | null | undefined)).toBe(false);
    }
  });

  it('keeps an unknown stored value visible instead of rendering an empty select', () => {
    // The alternative is a field that silently shows nothing over data the
    // operator cannot see and therefore cannot correct.
    const opts = protocolOptions('vless');
    expect(opts.map((o) => o.value)).toContain('vless');
    expect(opts.length).toBe(LINK_PROTOCOL_VALUES.length + 1);

    expect(protocolOptions('xray').length).toBe(LINK_PROTOCOL_VALUES.length);
    expect(protocolOptions(null).length).toBe(LINK_PROTOCOL_VALUES.length);
  });
});

describe('which protocols may choose an engine', () => {
  // The last unpaired list in the profile form. `ENGINE_CHOICE_PROTOCOLS` is
  // what the form lets an operator pick a sing-box variant for, and
  // `ENGINE_OPTIONS` is what the API accepts a non-null engine for.
  //
  // The two failures are different and only one is loud. A protocol the API
  // allows and the form does not offer is a feature nobody can reach; a
  // protocol the form offers and the API does not allow is a save refused with
  // `engine "singbox" is not valid for protocol "..."`, which is the shape this
  // repository has already hit once in this very form.
  //
  // What the sides must agree on is CHOICE, not mere acceptance. An entry with
  // a single option - tuic, anytls and shadowtls, whose only core is sing-box -
  // gives the operator nothing to decide; it is there so a caller that names
  // that one core explicitly is not refused. Putting such a protocol in the
  // form would be a select with one item. So the comparison is against the
  // entries offering more than one core, and the single-option ones get their
  // own case below: they must stay OUT of the form and IN the API.
  const PROFILES = join(
    import.meta.dirname,
    '..', '..', '..', 'panel-backend', 'src', 'modules', 'profiles', 'profiles.schemas.ts',
  );
  const FORM = join(import.meta.dirname, 'ProfileFormModal.tsx');

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  }

  it('is the same set on both sides', () => {
    const back = stripComments(readFileSync(PROFILES, 'utf8'));
    const at = back.indexOf('const ENGINE_OPTIONS');
    expect(at, 'ENGINE_OPTIONS was renamed or moved').toBeGreaterThan(-1);
    const body = back.slice(at, back.indexOf('};', at));
    // Each entry with the cores it lists, so "may choose" can be told apart
    // from "is accepted".
    const entries = [...body.matchAll(/^\s*([a-z]+):\s*\[([^\]]*)\]/gm)].map((m) => ({
      protocol: m[1]!,
      cores: [...m[2]!.matchAll(/'([a-z-]+)'/g)].map((c) => c[1]!),
    }));
    expect(entries.length, 'the map parsed to almost nothing').toBeGreaterThan(1);

    const withAChoice = entries.filter((e) => e.cores.length > 1).map((e) => e.protocol).sort();
    const singleCore = entries.filter((e) => e.cores.length === 1).map((e) => e.protocol).sort();
    expect(withAChoice.length, 'no protocol offers a choice at all').toBeGreaterThan(0);

    const form = stripComments(readFileSync(FORM, 'utf8'));
    const m = /const ENGINE_CHOICE_PROTOCOLS = \[([^\]]*)\]/.exec(form);
    expect(m, 'ENGINE_CHOICE_PROTOCOLS was renamed or moved').not.toBeNull();
    const formSide = [...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!).sort();

    expect(
      formSide,
      'the form and the API disagree on who may choose an engine',
    ).toEqual(withAChoice);

    // And the other half: a single-core protocol must not be offered as a
    // choice, but must still be accepted when a caller names that core.
    for (const p of singleCore) {
      expect(formSide, `${p} has one core and is offered as a choice`).not.toContain(p);
    }
  });
});
