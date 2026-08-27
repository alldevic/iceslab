import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AWG_FIELDS, WG_KEY_RE, awgFieldError, type AwgFormValues } from './awgRules.js';

/**
 * One set of rules, written on three sides, in two languages.
 *
 * The node refuses an AmneziaWG interface it cannot serve — `validate()` in
 * `internal/core/amneziawg/config.go`. The panel schema mirrors it, and says
 * why in a comment above its superRefine: "Mirror the constraints the node's
 * config.go validate() enforces at deploy time, so the operator gets a clear
 * form error instead of a confusing `config push failed` after save."
 *
 * Measured 2026-08-27, before this file: the chain was broken in two places and
 * in both directions.
 *
 *   - `Jmin <= Jmax` was on the node and NOT in the panel schema, so the one
 *     inverted range two steppers can reach saved cleanly and failed at the
 *     push — the exact outcome that comment names.
 *   - NONE of the rules were in the form, so every one of them arrived as a 400
 *     with the message on a field the form does not point at.
 *
 * So the pairing is asked here, mechanically, in the direction that matters:
 * for each rule, the sides that must carry it, and a value that violates it.
 * A rule added to the node or to the schema without reaching the form fails the
 * row it belongs to; a rule the form invents on its own fails the same row from
 * the other end.
 */

/**
 * Comments go first, on both sides.
 *
 * The first version of this file compared against the raw source and passed a
 * mutation that DELETED the `jmin > jmax` rule from the panel schema: the
 * comment above the rule quotes the node's own message, so the pattern matched
 * prose explaining the rule instead of the rule. The same trap is on record in
 * this repository twice — a search for `prisma.inbound` that found its own
 * comment, and an i18n scan that read a key from the line above the value.
 *
 * Tail `//` is left alone deliberately: cutting it would eat the `//` in a URL
 * or in a string literal and could hide a real match after it.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const HERE = import.meta.dirname;
const BACKEND = join(HERE, '..', '..', '..', 'panel-backend', 'src');
const NODE_GO = join(HERE, '..', '..', '..', 'node', 'internal', 'core', 'amneziawg', 'config.go');
const SCHEMA = join(BACKEND, 'modules', 'inbounds', 'inbounds.schemas.ts');

const OK: AwgFormValues = {
  protocol: 'amneziawg',
  awgJmin: 64,
  awgJmax: 128,
  awgS1: 32,
  awgS2: 56,
  awgH1: 100,
  awgH2: 200,
  awgH3: 300,
  awgH4: 400,
  awgServerPriv: 'H1skb6gXGFnftS9xrAzHUeNT/gIbGy34a9xq89xQHFM=',
  awgServerPub: 'aP8lgNU9c2vTGSvljeH1JO1qfCWQ6LwdVT92/RBO/FA=',
};

interface Rule {
  what: string;
  /** Must appear in the node's validate(); null when the node has no such rule. */
  node: RegExp | null;
  /** Must appear in the panel schema. */
  panel: RegExp;
  /** The form field the message lands on, and a value that earns it. */
  field: (typeof AWG_FIELDS)[number];
  violation: Partial<AwgFormValues>;
}

const RULES: Rule[] = [
  {
    what: 'H1-H4 pairwise distinct',
    node: /H1-H4 must be pairwise distinct/,
    panel: /H1-H4 must be pairwise distinct/,
    field: 'awgH2',
    violation: { awgH2: 100 },
  },
  {
    what: 'Jmin <= Jmax',
    node: /Jmin \(%d\) must be <= Jmax \(%d\)/,
    panel: /must be <= Jmax/,
    field: 'awgJmax',
    violation: { awgJmin: 512, awgJmax: 128 },
  },
  {
    what: 's1 + 56 != s2 (the plain WireGuard handshake length)',
    // The node does NOT check this one, and that asymmetry is the point: it is
    // about how the flow LOOKS, not about whether the interface comes up, so
    // the panel is the only side that can refuse it.
    node: null,
    panel: /s1 \+ 56 must not equal s2/,
    field: 'awgS2',
    violation: { awgS1: 0, awgS2: 56 },
  },
  {
    what: 'the server keys are 44 base64 characters',
    node: /wg key must be 44 base64 chars/,
    panel: /\[A-Za-z0-9\+\/\]\{43\}=/,
    field: 'awgServerPriv',
    violation: { awgServerPriv: 'not-a-key' },
  },
];

const haveNode = existsSync(NODE_GO);
const haveBackend = existsSync(SCHEMA);

describe('the AmneziaWG rules, on all three sides', () => {
  it('the two other sides are next to this checkout, and are the files they claim to be', () => {
    // The control. Without it a renamed file turns every case below into a
    // silent pass on an empty string.
    if (!haveNode || !haveBackend) {
      expect.fail(
        `CROSS-REPO HALF NOT RUN: node=${haveNode ? 'ok' : NODE_GO}, backend=${haveBackend ? 'ok' : SCHEMA}`,
      );
    }
    expect(readFileSync(NODE_GO, 'utf8')).toContain('func (c *InboundConfig) validate()');
    expect(readFileSync(SCHEMA, 'utf8')).toContain('AmneziawgConfigSchema');
  });

  it.each(RULES.map((r) => [r.what, r] as const))('%s — the node has it', (_w, rule) => {
    if (!haveNode || rule.node === null) return;
    expect(
      code(readFileSync(NODE_GO, 'utf8')),
      'the node stopped enforcing a rule the panel and the form still refuse',
    ).toMatch(rule.node);
  });

  it.each(RULES.map((r) => [r.what, r] as const))('%s — the panel schema has it', (_w, rule) => {
    if (!haveBackend) return;
    expect(
      code(readFileSync(SCHEMA, 'utf8')),
      'the schema is missing a rule, so this shape saves and fails at the push',
    ).toMatch(rule.panel);
  });

  it.each(RULES.map((r) => [r.what, r] as const))('%s — the form refuses it too', (_w, rule) => {
    const values = { ...OK, ...rule.violation };
    expect(
      awgFieldError(rule.field, values),
      'the form accepts a shape the other two refuse: a 400 after save',
    ).not.toBeNull();
  });

  it('the form seeds the magic headers with the numbers the schema defaults to', () => {
    if (!haveBackend) return;
    // Not cosmetic. These four fields have no preset behind them and no
    // placeholder telling an operator what to type, so whatever the form starts
    // with is what almost every AmneziaWG profile ships with — and until
    // 2026-08-27 it started with nothing and submitted zero, which the schema
    // and the node both refuse. Pairing the two lists is what stops the form
    // and the schema drifting to two different sets of "defaults", where an
    // operator who clears a field gets a value the API accepts and a colleague
    // who never touched it gets another.
    const schema = code(readFileSync(SCHEMA, 'utf8'));
    const form = code(readFileSync(join(HERE, '..', 'components', 'ProfileFormModal.tsx'), 'utf8'));

    const fromSchema: Record<string, string> = {};
    for (const m of schema.matchAll(/^\s*(h[1-4]): z\.number\(\)[^\n]*?\.default\((\d+)\)/gm)) {
      fromSchema[m[1]!] = m[2]!;
    }
    expect(Object.keys(fromSchema).sort(), 'no h1-h4 defaults parsed out of the schema').toEqual([
      'h1',
      'h2',
      'h3',
      'h4',
    ]);

    const block = /const AWG_HEADER_DEFAULTS = \{([^}]*)\}/.exec(form);
    expect(block, 'the form has no AWG_HEADER_DEFAULTS to compare against').not.toBeNull();
    const fromForm = Object.fromEntries(
      [...block![1]!.matchAll(/(h[1-4]):\s*(\d+)/g)].map((m) => [m[1]!, m[2]!]),
    );

    expect(fromForm, 'the form seeds headers the schema would not default to').toEqual(fromSchema);
  });

  it('and the key rule is the SAME rule, not two that happen to agree today', () => {
    if (!haveBackend) return;
    // Both sides are read back and compared as patterns rather than by trying
    // a few strings: two regexes can agree on every vector a test remembers to
    // write and disagree on the one an operator pastes.
    const schema = code(readFileSync(SCHEMA, 'utf8'));
    // `[^/]+` for the pattern body is wrong and this test found it out the
    // hard way: the body CONTAINS a slash, inside `[A-Za-z0-9+/]`, so the
    // capture failed there, the engine backtracked to a later mention of
    // WgKeySchema and matched a hostname rule seventy lines further down.
    // A lazy `.+?` up to `/,` reads the whole body; the assertion below that it
    // is the key rule at all is what stops the next mis-extraction from
    // quietly comparing something else.
    const m = /const WgKeySchema = z[\s\S]*?\.regex\(\s*\/(.+?)\/,/.exec(schema);
    expect(m, 'no WgKeySchema regex found in the panel schema').not.toBeNull();
    expect(m![1], 'the extraction picked up some other rule').toContain('{43}');
    expect(m![1], 'the panel and the form disagree on what a WireGuard key is').toBe(
      WG_KEY_RE.source,
    );
  });
});
