import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/render';
import { UpdateNodeSchema } from '../../../panel-backend/src/modules/nodes/nodes.schemas';
import { aNode } from '../test/records';

/**
 * Putting a node back in service.
 *
 * `status: 'disabled'` is written by the F2 cold pool when it retires a node,
 * and until 2026-08-29 nothing could write it back: the field was not in
 * `UpdateNodeSchema`, no editor drew a control for it, and — because zod strips
 * unknown keys — `PUT /api/nodes/:id {"status":"active"}` answered 200 and
 * changed nothing. A disabled node is out of every subscription
 * (`status: { not: 'disabled' }`), out of the status poller, and answers
 * `disabled` on its heartbeat, so the only way back was SQL.
 *
 * A node has TWO editors, the modal on the list and the page behind
 * `/nodes/:id`, and each keeps its own `defaults()` and its own payload. Both
 * are asked here, in both directions.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
    listProfiles: vi.fn(async () => ({ profiles: [] })),
    listSquads: vi.fn(async () => ({ squads: [] })),
    listBindings: vi.fn(async () => ({ bindings: [] })),
    listHosts: vi.fn(async () => ({ hosts: [] })),
    listRegions: vi.fn(async () => ({ regions: [] })),
    listCascades: vi.fn(async () => ({ cascades: [] })),
    listRoutePolicies: vi.fn(async () => ({ policies: [] })),
    getDashboardOverview: vi.fn(async () => ({ nodes: [], users: [] })),
    findNode: vi.fn(async () => ({ ...aNode(), id: 'node-1', status: 'disabled' })),
    updateNode: (id: string, input: unknown) => updateNode(id, input),
  };
});

import { NodeEditModal } from './NodeEditModal';
import { NodeEditPage } from '../pages/NodeEditPage';

const updateNode = vi.fn(async (_id: string, _input: unknown) => ({}));

describe('the node editor can take a node out of service and put it back', () => {
  it('a disabled node opens with the switch off, and turning it on sends active', async () => {
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <NodeEditModal
        opened
        onClose={() => {}}
        node={{ ...aNode(), status: 'disabled' }}
        saving={false}
        refreshing={false}
        onSubmit={onSubmit}
        onDelete={() => {}}
        onRefreshBootstrap={() => {}}
      />,
    );

    // Mantine puts the description inside the <label>, so the accessible name
    // is the label AND its explanation - matched by prefix rather than exactly.
    const toggle = await screen.findByLabelText(/^In service/);
    expect((toggle as HTMLInputElement).checked, 'a disabled node looked in service').toBe(false);
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = (onSubmit.mock.calls as unknown[][])[0][0];
    expect(payload).toMatchObject({ status: 'active' });
    // And the API takes it: the schema is imported, not restated.
    const parsed = UpdateNodeSchema.safeParse(payload);
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    ).toEqual([]);
  });

  it('an active node can be taken out of service', async () => {
    const onSubmit = vi.fn(async () => {});
    const { user } = renderWithProviders(
      <NodeEditModal
        opened
        onClose={() => {}}
        node={{ ...aNode(), status: 'online' }}
        saving={false}
        refreshing={false}
        onSubmit={onSubmit}
        onDelete={() => {}}
        onRefreshBootstrap={() => {}}
      />,
    );

    // Mantine puts the description inside the <label>, so the accessible name
    // is the label AND its explanation - matched by prefix rather than exactly.
    const toggle = await screen.findByLabelText(/^In service/);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect((onSubmit.mock.calls as unknown[][])[0][0]).toMatchObject({ status: 'disabled' });
  });
});

describe('the other node editor - the page behind /nodes/:id - agrees', () => {
  it('a disabled node opens with the switch off, and saving puts it back in service', async () => {
    updateNode.mockClear();
    const { user } = renderWithProviders(
      <Routes>
        <Route path="/nodes/:id" element={<NodeEditPage />} />
      </Routes>,
      { route: '/nodes/node-1' },
    );

    const toggle = await screen.findByLabelText(/^In service/);
    expect((toggle as HTMLInputElement).checked, 'a disabled node looked in service').toBe(false);
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(updateNode).toHaveBeenCalledTimes(1));
    const payload = (updateNode.mock.calls as unknown[][])[0][1];
    expect(payload).toMatchObject({ status: 'active' });
    const parsed = UpdateNodeSchema.safeParse(payload);
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    ).toEqual([]);
  });
});
