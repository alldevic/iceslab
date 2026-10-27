import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyCascadeOutTag } from '../../modules/cascades/cascade.config.js';

/**
 * The names of a cascade way out live in two places (A-232): the panel prints
 * them (dirOutTag, chainOutTag, through policyCascadeOutTag) and the agent
 * reads them back (legacyExitRe, handoverExitRe in its xray config.go) to fit a
 * node-policy rule to the drawing it actually renders (fitCascadeExits, A-108).
 * A tag renamed on one side would not fail anything: the agent would simply
 * drop every cascade rule, silently in the config and only in its journal.
 *
 * So the agent's patterns and the names it swaps in are read from its source
 * here and held against what the panel prints, as contract-mirror.test.ts
 * holds the engine names.
 */
const CONFIG_GO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/node/internal/core/xray/config.go');
const src = readFileSync(CONFIG_GO, 'utf8');

function goRegexp(name: string): RegExp {
  const m = new RegExp(`${name}\\s*=\\s*regexp\\.MustCompile\\(\`([^\`]+)\`\\)`).exec(src);
  expect(m, `${name} was not found in config.go; fix the pattern, do not delete the test`).not.toBeNull();
  return new RegExp(m![1]!);
}

describe('the names of a cascade way out, panel and agent', () => {
  const legacy = goRegexp('legacyExitRe');
  const handover = goRegexp('handoverExitRe');

  it('the agent reads what the panel prints, direction number included', () => {
    for (const tag of [1, 7, 42]) {
      expect(legacy.exec(policyCascadeOutTag(tag, 'legacy')!)?.[1]).toBe(String(tag));
      expect(handover.exec(policyCascadeOutTag(tag, 'handover')!)?.[1]).toBe(String(tag));
      // And neither takes the other's name.
      expect(legacy.test(policyCascadeOutTag(tag, 'handover')!)).toBe(false);
      expect(handover.test(policyCascadeOutTag(tag, 'legacy')!)).toBe(false);
    }
  });

  it('the name the agent swaps in is the one the panel prints for the other drawing', () => {
    const toHandover = /other, direction = "([^"]+)"\s*\+\s*m\[1\], m\[1\]/.exec(src)?.[1];
    const toLegacy = /other, direction = "([^"]+)"\s*\+\s*m\[1\]\s*\+\s*"([^"]+)", m\[1\]/.exec(src);
    expect(toHandover, 'the swap to the hand-over name was not found in fitCascadeExits').toBeDefined();
    expect(toLegacy, 'the swap to the legacy name was not found in fitCascadeExits').not.toBeNull();
    expect(`${toHandover}7`).toBe(policyCascadeOutTag(7, 'handover'));
    expect(`${toLegacy![1]}7${toLegacy![2]}`).toBe(policyCascadeOutTag(7, 'legacy'));
  });
});
