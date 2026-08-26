import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rules the profile form applies on the operator's behalf, against the
 * rules the API applies on save.
 *
 * `ProfileFormModal.tsx` says of its field list that "names + defaults mirror
 * the backend Zod schema exactly so the payload validates without a round-trip".
 * That is a contract, and it is written down twice in two languages with a
 * comment holding it together. Both directions of drift are real and they fail
 * differently:
 *
 *   - the form offers a value the schema refuses → the operator builds a
 *     config they were invited to build and is told no at the end, which is
 *     what the REALITY×transport rule looked like before the schema learned it;
 *   - the form refuses a shape the schema keeps → a working configuration the
 *     panel simply will not let anyone reach, with nothing to explain it. That
 *     one has already happened here: the form caught `xhttp + Vision` as an
 *     error while the backend preserved it deliberately.
 *
 * Read off both sources rather than restated here: a third copy of the list is
 * the thing being tested.
 */

const FORM = join(import.meta.dirname, 'ProfileFormModal.tsx');
const SCHEMAS = join(
  import.meta.dirname,
  '..', '..', '..', 'panel-backend', 'src', 'modules', 'inbounds', 'inbounds.schemas.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** String literals of a `const NAME = [...]` array, or a `new Set([...])`. */
function literalList(src: string, name: string): string[] {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} not found; it was renamed and this comparison would be empty`);
  const items = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (items.length === 0) throw new Error(`${name} parsed to an empty list`);
  return items.sort();
}

/** Members of a `z.enum([...])` given the property or exported name it is bound to. */
function zodEnum(src: string, binding: string): string[] {
  const re = new RegExp(`${binding}\\s*[:=]\\s*z\\.enum\\(\\[([^\\]]*)\\]`);
  const m = src.match(re);
  if (!m) throw new Error(`z.enum for ${binding} not found in the schema`);
  const items = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (items.length === 0) throw new Error(`the z.enum for ${binding} parsed to an empty list`);
  return items.sort();
}

/** Members of a union on a field of the form's FormValues type. */
function formUnion(src: string, field: string): string[] {
  const at = src.search(new RegExp(`^\\s{2}${field}:`, 'm'));
  if (at < 0) throw new Error(`FormValues.${field} not found; the form's field list changed`);
  const body = src.slice(at, src.indexOf(';', at));
  const items = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (items.length === 0) throw new Error(`FormValues.${field} is not a string union`);
  return items.sort();
}

/** `value: 'x'` entries of the Mantine Select whose label key contains `marker`. */
function selectValues(src: string, marker: string): string[] {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`no Select found near ${marker}`);
  const open = src.indexOf('data={[', at);
  if (open < 0) throw new Error(`the Select near ${marker} has no data array`);
  const body = src.slice(open, src.indexOf(']}', open));
  const items = [...body.matchAll(/value: '([^']*)'/g)].map((x) => x[1]!);
  if (items.length === 0) throw new Error(`the Select near ${marker} offers nothing`);
  return items.sort();
}

describe('the profile form and the API agree on what a profile may be', () => {
  const form = read(FORM);
  const schemas = read(SCHEMAS);

  // The control for the whole file: both sides have to have parsed. Every case
  // below compares two lists, and two empty lists are equal.
  it('reads both sources', () => {
    expect(form.length).toBeGreaterThan(50_000);
    expect(schemas).toContain('XrayConfigSchema');
  });

  it('offers exactly the stream transports the schema accepts', () => {
    expect(formUnion(form, 'xrayNetwork')).toEqual(zodEnum(schemas, 'network'));
  });

  it('offers exactly the security modes the schema accepts', () => {
    expect(formUnion(form, 'xraySecurity')).toEqual(zodEnum(schemas, 'security'));
  });

  it('offers exactly the xhttp modes the schema accepts', () => {
    expect(formUnion(form, 'xrayXhttpMode')).toEqual(zodEnum(schemas, 'xhttpMode'));
    // ...and the dropdown offers every one of them. A mode present in the type
    // and missing from the Select is a mode no operator can pick.
    expect(selectValues(form, "profiles.form.cfg.xhttpModeLabel")).toEqual(
      zodEnum(schemas, 'xhttpMode'),
    );
  });

  it('offers exactly the subprotocols the schema accepts', () => {
    expect(formUnion(form, 'xraySubprotocol')).toEqual(zodEnum(schemas, 'subprotocol'));
  });

  it('offers exactly the REALITY modes the schema accepts', () => {
    expect(selectValues(form, 'profiles.form.cfg.realityModeLabel')).toEqual(
      zodEnum(schemas, 'realityMode'),
    );
  });

  it('offers exactly the shadowsocks ciphers the schema accepts', () => {
    expect(formUnion(form, 'ssMethod')).toEqual(zodEnum(schemas, 'ShadowsocksMethodSchema'));
    expect(selectValues(form, 'profiles.form.cfg.ssCipherLabel')).toEqual(
      zodEnum(schemas, 'ShadowsocksMethodSchema'),
    );
  });

  it('offers exactly the TUIC congestion controllers the schema accepts', () => {
    expect(formUnion(form, 'tuicCongestion')).toEqual(zodEnum(schemas, 'congestionControl'));
  });

  /**
   * The one rule both sides state as a named list, under the same name. The
   * form refuses to BUILD the combination and the schema refuses to STORE it;
   * a form list narrower than the schema's is a config nobody can reach, and a
   * wider one is an error at the end of a wizard.
   */
  it('draws the REALITY transport line in the same place as the schema', () => {
    expect(literalList(form, 'REALITY_TRANSPORTS')).toEqual(
      literalList(schemas, 'REALITY_TRANSPORTS'),
    );
  });

  /**
   * And the one the schema deliberately does NOT enforce. The comment on the
   * schema's `network` field says the operator must align flow and network
   * themselves, so this list exists only in the form — which is exactly why it
   * is worth pinning: it is the shape of the bug already found here once, where
   * the form called `xhttp + Vision` an error and the backend kept it on
   * purpose.
   */
  it('still allows Vision on both transports xray serves it over', () => {
    expect(literalList(form, 'FLOW_COMPATIBLE_TRANSPORTS')).toEqual(['raw', 'xhttp']);
    // Every flow-compatible transport must be a transport the form offers at
    // all, or the gate is keyed on a value that can never be selected.
    for (const t of literalList(form, 'FLOW_COMPATIBLE_TRANSPORTS')) {
      expect(formUnion(form, 'xrayNetwork')).toContain(t);
    }
    for (const t of literalList(form, 'REALITY_TRANSPORTS')) {
      expect(formUnion(form, 'xrayNetwork')).toContain(t);
    }
    for (const t of literalList(form, 'PATH_HOST_TRANSPORTS')) {
      expect(formUnion(form, 'xrayNetwork')).toContain(t);
    }
  });
});
