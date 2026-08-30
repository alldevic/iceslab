import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MieruConfigSchema } from './inbounds.schemas.js';

/**
 * A bound the panel accepts and the node refuses is a 201 followed by a push
 * that fails, and the operator sees "1/1 inbounds failed to apply" with no
 * message on any field - they were told the value was fine by the thing that
 * then could not deliver it.
 *
 * That is what mieru's MTU was. The schema said `min(576)`, the node's
 * validate() refuses anything under 1280 citing upstream's operation.md, and
 * the schema's own prose one line above already said 1280 - only the number
 * disagreed. Found 2026-08-30 comparing every panel schema bound against the
 * corresponding check in the node adapters; it was the only numeric range where
 * the two differed.
 *
 * So the range is READ from the node rather than restated here. A restatement
 * is a third copy of a number that already exists twice, and it would have
 * passed just as happily against the wrong one.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const nodeSrc = readFileSync(
  `${repoRoot}apps/node/internal/core/mieru/config.go`,
  'utf8',
);

/** The MTU range the node-agent enforces, from its own validate(). */
function nodeMtuRange(): { min: number; max: number } {
  // Comments are stripped first: the prose around this check names 1280 and
  // 1500 in a sentence, and matching that instead would make this test agree
  // with itself rather than with the code.
  const code = nodeSrc.replace(/\/\/.*$/gm, '');
  const m = code.match(/c\.MTU\s*<\s*(\d+)\s*\|\|\s*c\.MTU\s*>\s*(\d+)/);
  if (!m) throw new Error('the node no longer bounds MTU the way this test reads it');
  return { min: Number(m[1]), max: Number(m[2]) };
}

describe('the mieru MTU the panel accepts against the one the node enforces', () => {
  const { min, max } = nodeMtuRange();

  it('reads a plausible range out of the node', () => {
    // The control: a regex that matched a zero or an empty string would make
    // every case below vacuously true.
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });

  it('accepts the node floor and the node ceiling', () => {
    expect(MieruConfigSchema.safeParse({ mtu: min }).success).toBe(true);
    expect(MieruConfigSchema.safeParse({ mtu: max }).success).toBe(true);
  });

  it('refuses what the node would refuse, on the field, at save time', () => {
    const below = MieruConfigSchema.safeParse({ mtu: min - 1 });
    expect(
      below.success,
      `the panel accepts mtu ${min - 1}; the node answers "MTU out of range (${min}-${max})" and the push fails with nothing on the field`,
    ).toBe(false);
    expect(MieruConfigSchema.safeParse({ mtu: max + 1 }).success).toBe(false);
  });

  it('keeps a default inside the range both agree on', () => {
    const parsed = MieruConfigSchema.parse({});
    expect(parsed.mtu).toBeGreaterThanOrEqual(min);
    expect(parsed.mtu).toBeLessThanOrEqual(max);
  });
});
