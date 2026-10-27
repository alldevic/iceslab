import { describe, expect, it } from 'vitest';
import { versionAllows } from './recipes.registry.js';

/**
 * minPanelVersion means "needs what this version has", and a release
 * candidate carries what its release has (ARCH 26.10). So a panel on
 * 0.3.0-rc.1 shows a recipe for 0.3.0, while the update check (isNewer) still
 * reads 0.3.0 as newer than that candidate.
 */
describe('which recipes a panel version shows', () => {
  const needs = (minPanelVersion: string) => ({ minPanelVersion });

  it('a candidate shows the recipes of its release and not of the next one', () => {
    expect(versionAllows(needs('0.3.0'), '0.3.0-rc.1')).toBe(true);
    expect(versionAllows(needs('0.3.0'), 'v0.3.0-rc.2+b.7')).toBe(true);
    expect(versionAllows(needs('0.3.1'), '0.3.0-rc.1')).toBe(false);
  });

  it('an older release does not show a newer recipe, an equal or newer one does', () => {
    expect(versionAllows(needs('0.3.0'), '0.2.1')).toBe(false);
    expect(versionAllows(needs('0.3.0'), '0.3.0')).toBe(true);
    expect(versionAllows(needs('0.2.0'), '0.3.0-rc.1')).toBe(true);
  });

  it('no minimum, or a version that cannot be read, hides nothing', () => {
    expect(versionAllows({}, '0.1.0')).toBe(true);
    expect(versionAllows(needs('9.9.9'), 'unknown')).toBe(true);
  });
});
