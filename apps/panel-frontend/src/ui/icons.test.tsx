// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentType } from 'react';
import { cleanup, render } from '@testing-library/react';
import * as BrandIcons from '@/ui/BrandIcons';
import * as NavIcons from '@/ui/NavIcons';

/*
 * The two icon modules: inline SVG, no data path, no state. The one failure
 * they have is an export that is not a component, or one that draws nothing
 * because a path was emptied.
 */
const MODULES: [string, Record<string, unknown>][] = [
  ['BrandIcons', BrandIcons],
  ['NavIcons', NavIcons],
];

afterEach(cleanup);

describe.each(MODULES)('%s', (name, mod) => {
  const icons = Object.entries(mod).filter(([, v]) => typeof v === 'function') as [
    string,
    ComponentType<{ size?: number; color?: string }>,
  ][];

  it('exports icons at all', () => {
    // The control: an empty module would make the cases below vacuous, and
    // "exports nothing" is also what a renamed file looks like.
    expect(icons.length, `${name} exports no components`).toBeGreaterThan(3);
  });

  it.each(icons)('%s draws an svg', (iconName, Icon) => {
    const { container } = render(<Icon size={16} color="#fff" />);
    const svg = container.querySelector('svg');
    expect(svg, `${iconName} rendered no <svg>`).not.toBeNull();
    expect(svg!.innerHTML.length, `${iconName} drew an empty <svg>`).toBeGreaterThan(10);
  });
});
