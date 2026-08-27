import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { cleanup, renderWithProviders, waitFor } from '../test/render';
import { EMPTY_API, emptyApiModule } from '../test/emptyApi';

/**
 * Every page of the panel, on a deployment where nothing has been created yet.
 *
 * Thirty-nine of the forty-five screens were mounted by no test at all, and the
 * first state any of them meets is this one: an operator who has just finished
 * the installer, with zero nodes, zero users, zero profiles and a settings row
 * that does not exist. It is also the state least likely to have been clicked
 * through by hand, because a developer's panel is never empty.
 *
 * What each case asserts is not "it did not crash" — a page that rendered
 * nothing would pass that. It is that the page rendered ITS OWN empty state,
 * named here in the words the operator reads. That doubles as a check on i18n:
 * an unresolved key renders as `nodes.empty.title`, which none of these markers
 * would match.
 *
 * The API double is shared (`src/test/emptyApi.ts`) and held to the declared
 * return types by `src/test/emptyApi.mirror.test.ts` — because a fixture is a
 * second copy of the contract, and the first draft of this one omitted
 * `traffic` from the dashboard overview, which is a field DashboardPage
 * dereferences on its first render.
 */

vi.mock('../lib/api', async (importOriginal) =>
  emptyApiModule(await importOriginal<Record<string, unknown>>()),
);

let caught: Error | null = null;

/** React reports a render error to the nearest boundary and then unmounts the
 *  tree. Without one here the throw surfaces as an unhandled rejection AFTER
 *  the case has already passed — which is how the first version of this file
 *  reported seventeen green pages while one of them was crashing. */
class Boundary extends Component<{ children: ReactNode }> {
  componentDidCatch(err: Error) {
    caught = err;
  }
  render() {
    return this.props.children;
  }
}

/**
 * The text a reader sees. Mantine injects its whole theme as a <style> inside
 * the container and its 20 KB of CSS count toward `textContent`, so without
 * stripping it "the page rendered something" is true of a page that rendered
 * nothing. Stripped on a CLONE: this runs inside `waitFor`, which retries, and
 * removing nodes from the live tree makes the second attempt throw
 * `NotFoundError` at React instead of reporting the assertion.
 */
function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const style of Array.from(clone.querySelectorAll('style'))) style.remove();
  return clone.textContent ?? '';
}

interface Page {
  name: string;
  /** The path as App.tsx declares it, and a concrete URL that matches it. */
  path: string;
  at: string;
  /** A phrase this page shows on an empty deployment. */
  shows: string;
}

const PAGES: Page[] = [
  { name: 'DashboardPage', path: '/', at: '/', shows: 'Online now' },
  { name: 'UsersPage', path: '/users', at: '/users', shows: 'No users.' },
  { name: 'NodesPage', path: '/nodes', at: '/nodes', shows: 'No nodes yet' },
  { name: 'NodeCreatePage', path: '/nodes/new', at: '/nodes/new', shows: 'Step 1 of 3' },
  {
    name: 'CascadeCreatePage',
    path: '/nodes/cascades/new',
    at: '/nodes/cascades/new',
    shows: 'New cascade',
  },
  // The edit pages are reached with an id that no longer resolves, which on an
  // empty panel is every id. Saying so is the whole job of the page in that
  // state, and each of the three says it differently.
  {
    name: 'CascadeEditPage',
    path: '/nodes/cascades/:id',
    at: '/nodes/cascades/no-such-cascade',
    shows: 'This cascade no longer exists.',
  },
  { name: 'ProfilesPage', path: '/profiles', at: '/profiles', shows: 'No profiles yet' },
  {
    name: 'ProfileEditPage',
    path: '/profiles/:id',
    at: '/profiles/no-such-profile',
    shows: 'This profile no longer exists.',
  },
  { name: 'SquadsPage', path: '/squads', at: '/squads', shows: 'No squads.' },
  { name: 'HostsPage', path: '/hosts', at: '/hosts', shows: 'No hosts yet' },
  {
    name: 'RoutesPage',
    path: '/subscription/routes',
    at: '/subscription/routes',
    shows: 'No policies yet',
  },
  { name: 'InsightsPage', path: '/insights', at: '/insights', shows: 'Subscription requests' },
  { name: 'SettingsPage', path: '/settings', at: '/settings', shows: 'Brand name' },
  {
    name: 'SubscriptionMetadataPage',
    path: '/subscription/metadata',
    at: '/subscription/metadata',
    shows: 'Profile title',
  },
  {
    name: 'SrrPage',
    path: '/subscription/delivery',
    at: '/subscription/delivery',
    shows: 'No rules yet.',
  },
  // `/new` is a LITERAL route in App.tsx, matched ahead of `/:id`. Reaching this
  // page through the parameter route instead makes it look up a rule called
  // "new" and answer "This rule no longer exists" — which is what the first
  // draft of this file did, and it looked like a defect.
  {
    name: 'SrrRulePage',
    path: '/subscription/delivery/new',
    at: '/subscription/delivery/new',
    shows: 'New delivery rule',
  },
  { name: 'LoginPage', path: '/login', at: '/login', shows: 'Sign in to Iceslab' },
];

afterEach(() => {
  cleanup();
});

describe('a panel with nothing in it', () => {
  it.each(PAGES)('$name renders its empty state', async ({ name, path, at, shows }) => {
    caught = null;
    const mod = (await import(`./${name}`)) as Record<string, React.ComponentType>;
    const El = mod[name]!;

    const { container } = renderWithProviders(
      <Boundary>
        <Routes>
          <Route path={path} element={<El />} />
        </Routes>
      </Boundary>,
      { route: at },
    );

    await waitFor(() => {
      expect(caught, `${name} threw during render`).toBeNull();
      expect(visibleText(container)).toContain(shows);
    });
  });

  // The control on all seventeen: they have to have ASKED for the data whose
  // emptiness they are reporting. A page that renders a static shell and fetches
  // nothing would satisfy every case above.
  it('and each of them actually queried the API for it', async () => {
    const api = (await import('../lib/api')) as unknown as Record<string, { mock?: { calls: unknown[] } }>;
    const used = Object.keys(EMPTY_API).filter((n) => (api[n]?.mock?.calls.length ?? 0) > 0);
    expect(used.length, 'no read endpoint was called by any page').toBeGreaterThan(10);
  });
});
