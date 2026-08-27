import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { render } from '@testing-library/react';
import * as BrandIcons from './BrandIcons';
import * as NavIcons from './NavIcons';

/**
 * The two icon modules, which are the last screens nothing mounted.
 *
 * There is no data path here and no state — the whole content is inline SVG —
 * so the only failure they have is the one this catches: an export that is not
 * a component, or that renders nothing because a path was emptied. Worth the
 * twenty lines because it takes "mounted by a test" from 43 of 45 to all of
 * them, and a metric with two hand-waved exceptions is a metric nobody checks.
 */
const MODULES: [string, Record<string, unknown>][] = [
  ['BrandIcons', BrandIcons],
  ['NavIcons', NavIcons],
];

describe.each(MODULES)('%s', (name, mod) => {
  const icons = Object.entries(mod).filter(
    ([, v]) => typeof v === 'function',
  ) as [string, ComponentType<{ size?: number; color?: string }>][];

  it('exports icons at all', () => {
    // The control: an empty module would make the case below vacuous, and
    // "exports nothing" is also what a renamed file looks like.
    expect(icons.length, `${name} exports no components`).toBeGreaterThan(3);
  });

  it.each(icons)('%s draws an svg', (iconName, Icon) => {
    const { container } = render(<Icon size={16} color="#fff" />);
    const svg = container.querySelector('svg');
    expect(svg, `${iconName} rendered no <svg>`).not.toBeNull();
    // An <svg> with nothing in it is a hole in the UI that looks like a
    // rendering bug rather than a missing icon.
    expect(svg!.innerHTML.length, `${iconName} drew an empty <svg>`).toBeGreaterThan(10);
  });
});
