import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderWithProviders, waitFor } from '../test/render';
import { emptyApiModule } from '../test/emptyApi';
import { Boundary, caught, cyrillicIn, resetCaught, visibleText } from '../test/screens';
import { aNode, aProfile, aRoutePolicy, aRoutingPreset } from '../test/records';

/**
 * Every component the panel renders outside a page, on a deployment where
 * nothing has been created yet.
 *
 * Same question as `pages/pages.empty.test.tsx` and the same reason: these were
 * mounted by no test at all, and the modals and editors are where an operator
 * spends the time that matters — the node form, the user drawer, the squad
 * form, the two routing editors. Each is handed the props a page hands it, with
 * lists that are empty rather than absent, and has to render ITS OWN answer to
 * that.
 *
 * `testConnectProfile` is stubbed by name rather than through the shared
 * double: it is a MUTATION, and the double deliberately leaves mutations alone
 * so a test that fires one has to say so. This modal fires it on mount, which
 * is the behaviour, so it is stated here.
 */
vi.mock('../lib/api', async (importOriginal) =>
  emptyApiModule(await importOriginal<Record<string, unknown>>(), {
    testConnectProfile: vi.fn(async () => ({ results: [] })),
  }),
);

/** Language names are written in their own language on purpose. */
const ALLOWED_CYRILLIC = ['Русский'];

const noop = () => {};
const asyncNoop = async () => {};

interface Case {
  name: string;
  render: () => Promise<ReactNode>;
  /** A phrase this component shows when it has been handed nothing. */
  shows: string;
}

const CASES: Case[] = [
  {
    name: 'AppLayout',
    shows: 'Workspace',
    render: async () => {
      const M = await import('./AppLayout');
      return <M.AppLayout />;
    },
  },
  {
    name: 'CascadesPanel',
    shows: 'No cascades yet.',
    render: async () => {
      const M = await import('./CascadesPanel');
      return <M.CascadesPanel />;
    },
  },
  {
    name: 'CascadesView',
    shows: 'No cascades yet.',
    render: async () => {
      const M = await import('./CascadesView');
      return (
        <M.CascadesView
          rows={[]}
          layout="cards"
          onEdit={noop}
          onDelete={noop}
          onToggleEnabled={noop}
        />
      );
    },
  },
  {
    name: 'DeployProfileModal',
    // The point of this one: a picker over a fleet that has no nodes has to say
    // where nodes come from, not render an empty list.
    shows: 'create one under Nodes first',
    render: async () => {
      const M = await import('./DeployProfileModal');
      return <M.DeployProfileModal profile={aProfile()} onClose={noop} />;
    },
  },
  {
    name: 'DevicePresetEditor',
    shows: 'first match wins',
    render: async () => {
      const M = await import('./DevicePresetEditor');
      return <M.DevicePresetEditor preset={aRoutingPreset()} isDefault />;
    },
  },
  {
    name: 'EgressPolicyEditor',
    shows: 'Geo split (per node)',
    render: async () => {
      const M = await import('./EgressPolicyEditor');
      return (
        <M.EgressPolicyEditor
          opened
          nodeLabel="ams-1"
          policy={[]}
          directions={[]}
          onClose={noop}
          onSave={noop}
        />
      );
    },
  },
  {
    name: 'GeoPanel',
    shows: 'Not built yet',
    render: async () => {
      const M = await import('./GeoPanel');
      return <M.GeoPanel />;
    },
  },
  {
    name: 'HostsManager',
    shows: "This binding has zero hosts - users won't receive URLs",
    render: async () => {
      const M = await import('./HostsManager');
      return (
        <M.HostsManager
          bindingId="binding-1"
          protocol={'vless' as never}
          hosts={[]}
          nodeId="node-1"
        />
      );
    },
  },
  {
    name: 'LanguageSwitcher',
    shows: 'en',
    render: async () => {
      const M = await import('./LanguageSwitcher');
      return <M.LanguageSwitcher />;
    },
  },
  {
    name: 'NodeCard',
    shows: 'ams-1',
    render: async () => {
      const M = await import('./NodeCard');
      return (
        <M.NodeCard
          node={
            {
              id: 'node-1',
              name: 'ams-1',
              status: 'online',
              countryCode: 'NL',
              regionLabel: null,
              maxUsers: null,
              approxUsers: 0,
              lastStatusChange: null,
            } as never
          }
          onEdit={noop}
          onDelete={noop}
          onRefreshBootstrap={noop}
        />
      );
    },
  },
  {
    name: 'NodeEditModal',
    shows: 'Parameters',
    render: async () => {
      const M = await import('./NodeEditModal');
      return (
        <M.NodeEditModal
          opened
          onClose={noop}
          node={aNode()}
          onSubmit={asyncNoop}
          onDelete={noop}
          onRefreshBootstrap={noop}
        />
      );
    },
  },
  {
    name: 'NodePayloadModal',
    shows: 'provisioning',
    render: async () => {
      const M = await import('./NodePayloadModal');
      return (
        <M.NodePayloadModal opened onClose={noop} nodeName="ams-1" payload="cGF5bG9hZA==" />
      );
    },
  },
  {
    name: 'RecipeExportModal',
    shows: 'Export as recipe',
    render: async () => {
      const M = await import('./RecipeExportModal');
      return <M.RecipeExportModal opened onClose={noop} protocol={'vless' as never} values={{}} />;
    },
  },
  {
    name: 'RoutePolicyEditor',
    shows: 'first match wins',
    render: async () => {
      const M = await import('./RoutePolicyEditor');
      return <M.RoutePolicyEditor policy={aRoutePolicy()} squads={[]} />;
    },
  },
  {
    name: 'SquadFormModal',
    shows: 'New squad',
    render: async () => {
      const M = await import('./SquadFormModal');
      return (
        <M.SquadFormModal
          opened
          onClose={noop}
          squad={null}
          profiles={[]}
          onSubmit={asyncNoop}
        />
      );
    },
  },
  {
    name: 'TestConnectModal',
    // An empty result list is the answer for a profile with no enabled
    // bindings, and it is the string this component used to carry in Russian.
    shows: 'This profile has no enabled bindings',
    render: async () => {
      const M = await import('./TestConnectModal');
      return <M.TestConnectModal profile={aProfile()} onClose={noop} />;
    },
  },
  {
    name: 'Toolbar',
    shows: 'a toolbar child',
    render: async () => {
      const M = await import('./Toolbar');
      return <M.Toolbar>a toolbar child</M.Toolbar>;
    },
  },
  {
    name: 'UserDrawer',
    shows: 'New user',
    render: async () => {
      const M = await import('./UserDrawer');
      return <M.UserDrawer opened onClose={noop} user={null} onSubmit={asyncNoop} />;
    },
  },
];

afterEach(() => {
  cleanup();
});

describe('handed nothing', () => {
  it.each(CASES)('$name renders its empty state', async ({ name, render, shows }) => {
    resetCaught();
    renderWithProviders(<Boundary>{await render()}</Boundary>);

    await waitFor(() => {
      expect(caught, `${name} threw during render`).toBeNull();
      // Read off document.body, not the container: a Mantine Modal or Drawer
      // renders through a portal, and half of these are one.
      expect(visibleText(document.body)).toContain(shows);
    });

    expect(
      cyrillicIn(visibleText(document.body)).filter((s) => !ALLOWED_CYRILLIC.includes(s)),
      `${name} renders Russian text with the UI in English: it never went through t()`,
    ).toEqual([]);
  });

  // Not in the table above, and each for its own reason.
  it('RecipePicker renders nothing rather than an empty header', async () => {
    // Its own comment says so: "Nothing to offer for this protocol (no
    // built-ins, empty registry, done loading): render nothing so the form
    // doesn't grow an empty header." Pinned because "renders nothing" and
    // "failed to render" look identical from outside, and the next reader
    // deserves to know which this is.
    resetCaught();
    const M = await import('./RecipePicker');
    const { container } = renderWithProviders(
      <Boundary>
        <M.RecipePicker protocol={'vless' as never} onPick={noop} />
      </Boundary>,
    );
    // Waited for rather than read straight after the mount: while the registry
    // query is in flight the picker DOES render its header ("0 of 0 recipes"),
    // and only the resolved-and-empty state collapses it. Asserting too early
    // reads that header and calls the documented behaviour a defect.
    await waitFor(() => {
      expect(caught).toBeNull();
      expect(visibleText(container)).toBe('');
    });
  });

  it('ProtectedRoute sends a caller with no token to the login page', async () => {
    const [{ Route, Routes }, M, { useAuth }] = await Promise.all([
      import('react-router-dom'),
      import('./ProtectedRoute'),
      import('../stores/auth'),
    ]);
    useAuth.setState({ token: null });
    renderWithProviders(
      <Routes>
        <Route element={<M.ProtectedRoute />}>
          <Route path="/secret" element={<div>the secret</div>} />
        </Route>
        <Route path="/login" element={<div>the login page</div>} />
      </Routes>,
      { route: '/secret' },
    );
    expect(visibleText(document.body)).toContain('the login page');
    expect(visibleText(document.body)).not.toContain('the secret');
  });
});
