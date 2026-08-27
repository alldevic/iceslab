import { describe, expect, it, vi } from 'vitest';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/render';
import type { Node } from '../lib/api';

/**
 * Which record a node edit form is showing.
 *
 * Eight screens in this app seed a form from a query and then have to decide
 * when to seed again. Seven of them key that decision on the record's identity
 * — `loadedFor === cascade.id`, `seededId === squad.id`, `[host?.id,
 * host?.updatedAt]`, `loadedFor === preset.id`, and so on. This one keyed it on
 * a bare `seeded` boolean, so the seed happens once per MOUNT rather than once
 * per record: `/nodes/:id` is one route, React Router does not remount when
 * only the parameter changes, and the form then shows the previous node's name,
 * address, protocol, country, multiplier and user cap under the new node's
 * heading. Save writes them onto the new node.
 *
 * Stated plainly: no control in the app performs that navigation today — every
 * button on this page goes to `/nodes` or `/hosts/new`, so reaching it means
 * the address bar. The reason to close it anyway is that it is one line and the
 * other seven already read the same way; the day someone links one node to its
 * cascade peer, this page silently starts saving the wrong machine.
 */

const findNode = vi.fn();

const EMPTY_LIST = { nodes: [], total: 0, page: 1, limit: 100 };

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    findNode: (...a: unknown[]) => findNode(...a),
    listNodes: vi.fn(async () => EMPTY_LIST),
    listRegions: vi.fn(async () => ({ regions: [] })),
    listCascades: vi.fn(async () => ({ cascades: [] })),
    listBindings: vi.fn(async () => ({ bindings: [] })),
    listHosts: vi.fn(async () => ({ hosts: [] })),
    listProfiles: vi.fn(async () => ({ profiles: [] })),
    listSquads: vi.fn(async () => ({ squads: [] })),
    listRoutePolicies: vi.fn(async () => ({ policies: [] })),
    getDashboardOverview: vi.fn(async () => ({ nodes: [], users: [] })),
  };
});

import { NodeEditPage } from './NodeEditPage';

function makeNode(over: Partial<Node> & Pick<Node, 'id' | 'name' | 'address'>): Node {
  return {
    protocol: 'xray' as Node['protocol'],
    countryCode: 'nl',
    status: 'online',
    lastStatusChange: null,
    lastStatusMessage: null,
    coreRestarts: null,
    coreVersion: '26.3.27',
    consumptionMultiplier: '1',
    regionId: null,
    maxUsers: null,
    domain: null,
    warpEnabled: false,
    singboxEngine: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as Node;
}

const FIRST = makeNode({ id: 'node-1', name: 'ams-1', address: '203.0.113.10:1337' });
const SECOND = makeNode({
  id: 'node-2',
  name: 'fra-1',
  address: '198.51.100.20:2337',
  countryCode: 'de',
});

/** A control that lives OUTSIDE the routed element, so navigating with it
 *  changes the parameter without unmounting the page — which is what a link
 *  from one node to another would do. */
function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderAt(route: string) {
  return renderWithProviders(
    <>
      <GoTo to={`/nodes/${SECOND.id}`} />
      <Routes>
        <Route path="/nodes/:id" element={<NodeEditPage />} />
      </Routes>
    </>,
    { route },
  );
}

/** Mantine renders a required field's label as "Name *", so the queries match
 *  on a prefix rather than on equality. */
async function field(label: RegExp): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(label)) as HTMLInputElement;
}

describe('NodeEditPage seeding', () => {
  it('fills the form from the node it is editing', async () => {
    findNode.mockImplementation(async (id: string) => (id === FIRST.id ? FIRST : SECOND));
    renderAt(`/nodes/${FIRST.id}`);

    // The control on both cases: a page that never seeded would also "show no
    // other node's data", because nothing would have rendered.
    await waitFor(async () => expect((await field(/^Name/)).value).toBe('ams-1'));
    expect((await field(/^Address/)).value).toBe('203.0.113.10');
  });

  it('shows the second node after the route parameter moves to it', async () => {
    findNode.mockImplementation(async (id: string) => (id === FIRST.id ? FIRST : SECOND));
    const { user } = renderAt(`/nodes/${FIRST.id}`);
    await waitFor(async () => expect((await field(/^Name/)).value).toBe('ams-1'));

    await user.click(screen.getByRole('button', { name: 'go' }));

    // The control for THIS case: the page has to have re-queried and rendered
    // the new node at all, or the assertion below is about a render that never
    // happened.
    await waitFor(() => expect(findNode).toHaveBeenCalledWith(SECOND.id));
    await waitFor(async () => expect((await field(/^Name/)).value).toBe('fra-1'));
    expect((await field(/^Address/)).value).toBe('198.51.100.20');
  });

  it('keeps what the operator typed when the record moves underneath', async () => {
    // The other direction, and the reason the key is the id ALONE. This page
    // invalidates `['node', id]` after every save and after the WARP and
    // bootstrap actions, and React Query refetches in the background whenever
    // the window regains focus — so a seed keyed on the id AND `updatedAt`
    // throws away an edit in progress the moment another admin touches the same
    // node. SquadEditPage, CascadeEditPage and SrrRulePage all key on the id
    // alone for this reason; HostEditPage deliberately does the opposite
    // (`[host?.id, host?.updatedAt]`, so a host saved elsewhere reappears), and
    // that split is a product decision, not drift — it is written down here so
    // the next reader does not "fix" one into the other.
    findNode.mockImplementation(async () => ({ ...FIRST }));
    const { user, queryClient } = renderAt(`/nodes/${FIRST.id}`);
    const name = await field(/^Name/);
    await waitFor(() => expect(name.value).toBe('ams-1'));

    await user.clear(name);
    await user.type(name, 'ams-1-edge');
    expect((await field(/^Name/)).value).toBe('ams-1-edge');

    // Somebody else renamed it while this form was open.
    findNode.mockImplementation(async () => ({
      ...FIRST,
      name: 'ams-1-renamed',
      updatedAt: '2026-08-28T09:00:00.000Z',
    }));
    await queryClient.invalidateQueries({ queryKey: ['node', FIRST.id] });

    // The control: the new record has to be in the cache, or the assertion
    // below is about a refetch that never landed.
    await waitFor(() =>
      expect(queryClient.getQueryData<Node>(['node', FIRST.id])?.name).toBe('ams-1-renamed'),
    );

    expect((await field(/^Name/)).value).toBe('ams-1-edge');
  });
});
