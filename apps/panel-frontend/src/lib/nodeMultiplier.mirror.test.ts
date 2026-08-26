import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One numeric rule, written in five places.
 *
 * `nodes.consumption_multiplier` is a BigInt column; the API validates it with
 * `z.number().int().positive()`. FOUR node forms render their own NumberInput
 * for it, and all four had `min={0.1} max={10} step={0.1}` — two of them with
 * `decimalScale={1} fixedDecimalScale`, so the control displayed "1.0" for a
 * column that cannot store it. The copies agreed with each other perfectly and
 * all four disagreed with the backend, which is why comparing them to each
 * other would have found nothing: the fifth copy is the one that decides.
 *
 * The failure was not silent-but-harmless. Every value the stepper could reach
 * below 1, and every fractional one, was OFFERED by the form and refused by the
 * API after the operator pressed save.
 *
 * `NodeFormModal.multiplier.test.tsx` is the other half: what the field does
 * with a decimal keystroke. This half is the one that covers all four screens,
 * because the next form to be added will copy the props, not the behaviour.
 */

const HERE = import.meta.dirname;
const SRC = join(HERE, '..');
const BACK = join(
  HERE, '..', '..', '..',
  'panel-backend', 'src', 'modules', 'nodes', 'nodes.schemas.ts',
);

/** Every screen that renders the multiplier control. */
const FORMS = [
  'components/NodeFormModal.tsx',
  'components/NodeEditModal.tsx',
  'pages/NodeCreatePage.tsx',
  'pages/NodeEditPage.tsx',
];

/**
 * The props of the NumberInput bound to `consumptionMultiplier`, read back from
 * the JSX. Throws rather than returning nothing: an extraction that stops
 * matching would make every case below vacuously true, which is the shape that
 * let this survive in the first place.
 */
function multiplierProps(src: string, where: string): string {
  const at = src.indexOf("getInputProps('consumptionMultiplier')");
  if (at < 0) throw new Error(`no consumptionMultiplier input in ${where}`);
  const open = src.lastIndexOf('<NumberInput', at);
  if (open < 0) throw new Error(`the multiplier field in ${where} is no longer a NumberInput`);
  return src.slice(open, at);
}

describe('every node form offers only multipliers the API accepts', () => {
  it('finds a multiplier control on all four screens', () => {
    // The control for the controls.
    for (const f of FORMS) {
      expect(multiplierProps(readFileSync(join(SRC, f), 'utf8'), f).length).toBeGreaterThan(20);
    }
    expect(FORMS.length, 'a form was added or removed without updating this list').toBe(4);
  });

  it.each(FORMS)('%s takes whole numbers only', (f) => {
    const props = multiplierProps(readFileSync(join(SRC, f), 'utf8'), f);
    expect(props, 'the column is a BigInt; a decimal is refused on save').toContain(
      'allowDecimal={false}',
    );
    expect(props, 'a decimal display for a column that cannot hold one').not.toContain(
      'fixedDecimalScale',
    );
  });

  it.each(FORMS)('%s starts no lower than 1', (f) => {
    const props = multiplierProps(readFileSync(join(SRC, f), 'utf8'), f);
    const min = /min=\{([0-9.]+)\}/.exec(props);
    expect(min, `no min= on the multiplier input in ${f}`).not.toBeNull();
    // `.positive()` on an integer means 1 is the floor. A min below it is the
    // form handing the operator a value the API will reject.
    expect(Number(min![1]), 'the stepper can reach a value the API refuses').toBeGreaterThanOrEqual(1);
  });

  // Half of this lives in the other package; say so in the name when it is not
  // here rather than passing on an empty comparison.
  const haveBack = existsSync(BACK);
  it(haveBack
    ? 'and the API still says integer-positive, so that floor is the right one'
    : 'CROSS-REPO HALF NOT RUN: nodes.schemas.ts is not next to this checkout', () => {
    if (!haveBack) return;
    const back = readFileSync(BACK, 'utf8');
    const decls = back.match(/consumptionMultiplier: z\.[^\n]+/g) ?? [];
    expect(decls.length, 'no consumptionMultiplier rule found in nodes.schemas.ts').toBeGreaterThan(0);
    for (const d of decls) {
      expect(d, `the API rule changed: ${d}`).toContain('.int()');
      expect(d, `the API rule changed: ${d}`).toContain('.positive()');
    }
  });
});
