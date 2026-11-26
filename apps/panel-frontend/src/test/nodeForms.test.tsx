// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, waitFor } from '@testing-library/react';
import { CreateNodeSchema, UpdateNodeSchema } from '@backend/modules/nodes/nodes.schemas';
import { installEmptyApi, type EmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { accepted, mountHook, sameWhereSent, theWrite } from '@/test/formDrive';
import { nodeRecord } from '@/test/records';
import { useNodeCreateForm } from '@/contours/nodes/components/NodeCreate/useNodeCreateForm';
import { useNodeEditForm } from '@/contours/nodes/components/NodeEdit/useNodeEditForm';
import { DEFAULT_NODE_PORT } from '@/contours/nodes/lib/nodeProtocols';
import type { Node } from '@/lib/domain/nodes';

/*
 * The node forms against the backend's own schemas (milestone 17.5): the
 * create wizard with only the required fields, and the edit form opened on a
 * stored node and saved. The hooks are mounted in the app's provider stack and
 * the request they build is read off the wire, then given to
 * CreateNodeSchema / UpdateNodeSchema, imported from the backend.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BOOTSTRAP = { token: 't', expiresAt: '2099-01-01T00:00:00.000Z', command: 'curl x | sh' };

/** `fields` is what a server of this generation says it renders; none = the old form of the wizard. */
const fleet = (fields: string[], nodes: Node[] = []) => ({
  re: /^\/api\/nodes$/,
  reply: { nodes, total: nodes.length, page: 1, limit: 100, fields },
});
const NEW_SERVER = ['coreVersions', 'intendedEngines'];

describe('node create wizard, required fields only', () => {
  async function submit(fields: string[], typed: { name: string; host: string }): Promise<{ api: EmptyApi; body: Record<string, unknown> }> {
    const api = installEmptyApi({
      routes: [fleet(fields)],
      onWrite: (r) => (r.method === 'POST' && r.url === '/api/nodes' ? { data: { ...nodeRecord(), bootstrap: BOOTSTRAP, payload: '' } } : undefined),
    });
    const hook = mountHook(() => useNodeCreateForm());
    // The wizard decides which contract it speaks after the fleet list arrives.
    await waitFor(() => expect(api.gets(/^\/api\/nodes$/).length).toBeGreaterThan(0));
    await waitFor(() => expect(hook.current.fleetView).toBe('ready'));
    act(() => hook.current.form.setValues(typed));
    await act(async () => {
      await hook.current.register();
    });
    return { api, body: theWrite(api.calls, 'POST', '/api/nodes').body as Record<string, unknown> };
  }

  it('on a server that knows intendedEngines the default request passes CreateNodeSchema', async () => {
    const { body } = await submit(NEW_SERVER, { name: 'n1', host: '203.0.113.7' });
    const parsed = accepted(CreateNodeSchema, body);
    expect(parsed.address).toBe(`203.0.113.7:${DEFAULT_NODE_PORT}`);
  });

  it('on a server older than the field (the old form) it passes too', async () => {
    const { body } = await submit([], { name: 'n1', host: 'node.example.test' });
    accepted(CreateNodeSchema, body);
  });
});

describe('node edit form, opened on a stored node and saved', () => {
  const STORED = nodeRecord({
    id: 'n1',
    name: 'edge-1',
    address: 'edge.example.test:8443',
    countryCode: 'DE',
    consumptionMultiplier: 1.5,
    maxUsers: 100,
    domain: 'edge.example.test',
    regionId: null,
    policyId: null,
    intendedEngines: ['xray'],
  });

  async function open(stored: Node) {
    const api = installEmptyApi({
      routes: [fleet(NEW_SERVER, [stored])],
      onWrite: (r) => (r.method === 'PUT' ? { data: stored } : undefined),
    });
    const hook = mountHook(() => useNodeEditForm(), { path: '/nodes/:id', route: `/nodes/${stored.id}` });
    await waitFor(() => expect(hook.current.node?.id).toBe(stored.id));
    await waitFor(() => expect(hook.current.form.values.name).toBe(stored.name));
    return { api, hook };
  }

  it('saved without an edit, the request passes UpdateNodeSchema and restates what was stored', async () => {
    const { api, hook } = await open(STORED);
    await act(async () => {
      await hook.current.saveMutation.mutateAsync();
    });
    const body = theWrite(api.calls, 'PUT', '/api/nodes/n1').body as Record<string, unknown>;
    accepted(UpdateNodeSchema, body);
    sameWhereSent(body, STORED as unknown as Record<string, unknown>);
    // The address goes back as host:port, the form's two fields joined.
    expect(body.address).toBe(STORED.address);
  });

  it('a stored multiplier with a decimal and a null limit come back as the same values', async () => {
    const stored = nodeRecord({ id: 'n1', name: 'free', consumptionMultiplier: 0, maxUsers: null, countryCode: null });
    const { api, hook } = await open(stored);
    await act(async () => {
      await hook.current.saveMutation.mutateAsync();
    });
    const body = theWrite(api.calls, 'PUT', '/api/nodes/n1').body as Record<string, unknown>;
    accepted(UpdateNodeSchema, body);
    sameWhereSent(body, stored as unknown as Record<string, unknown>);
  });

  it('a disabled node, its multiplier a string from a server older than the numeric DTO', async () => {
    const stored = nodeRecord({
      id: 'n1',
      name: 'old',
      address: 'old.example.test:2053',
      status: 'disabled',
      consumptionMultiplier: '0.5',
      countryCode: 'NL',
      domain: null,
    });
    const { api, hook } = await open(stored);
    await act(async () => {
      await hook.current.saveMutation.mutateAsync();
    });
    const body = theWrite(api.calls, 'PUT', '/api/nodes/n1').body as Record<string, unknown>;
    accepted(UpdateNodeSchema, body);
    // The string comes back as the number it stands for, and a disabled node is not switched on by a save.
    expect(body.consumptionMultiplier).toBe(0.5);
    expect(body).not.toHaveProperty('status');
    sameWhereSent(body, stored as unknown as Record<string, unknown>, ['consumptionMultiplier']);
  });
});
