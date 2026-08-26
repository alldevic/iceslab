import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/render';
import type { Binding, Host, Node, Profile } from '../lib/api';

/**
 * What a host edit form does with what the operator typed when the data
 * underneath it moves.
 *
 * The page seeds seventeen pieces of state from four independent queries, and
 * it has to re-seed once, because `bindings` and `nodes` can land after `hosts`
 * does and the port/country/profile fields are derived from them. The effect
 * expressed that as `bindings.length` and `nodes.length` in its dependency
 * list - but a length is not "the data arrived", it is "the data changed", and
 * every later change re-ran the whole seed on top of the form. Including
 * `setDirty(false)`, so nothing was left to warn anyone.
 *
 * The reachable case is the one the page's own error handler builds. A save
 * that 404s because the node or profile went away is answered by
 * `goneWhileEditing`: it invalidates nodes and bindings on purpose, because
 * refetching IS the fix - and that refetch is what wiped the form it was
 * recovering. The operator reads "the profile or node went away while this
 * form was open" over an already-reset page.
 *
 * SquadEditPage seeds the same way and depends on `[squad?.id,
 * squad?.updatedAt]` alone. Two copies of one decision; this is the copy that
 * had drifted.
 */

const listHosts = vi.fn();
const listBindings = vi.fn();
const listNodes = vi.fn();
const listProfiles = vi.fn();

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    listHosts: (...a: unknown[]) => listHosts(...a),
    listBindings: (...a: unknown[]) => listBindings(...a),
    listNodes: (...a: unknown[]) => listNodes(...a),
    listProfiles: (...a: unknown[]) => listProfiles(...a),
    // Answering "no opinion" is this endpoint's documented fallback: every
    // control stays visible. A rejection here would hide fields and the test
    // would fail on a missing input rather than on the seed.
    getProfileHostFields: vi.fn(async () => ({ fields: {} })),
  };
});

import { HostEditPage } from './HostEditPage';

const NODE: Node = {
  id: 'node-1',
  name: 'ams-1',
  address: '203.0.113.10',
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
};

const PROFILE: Profile = {
  id: 'profile-1',
  name: 'vless-reality',
  protocol: 'vless' as Profile['protocol'],
  engine: null,
  description: null,
  config: {} as Profile['config'],
  enabled: true,
  bindingCount: 1,
  userCount: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const BINDING: Binding = {
  id: 'binding-1',
  profileId: PROFILE.id,
  nodeId: NODE.id,
  port: 443,
  publicHost: null,
  publicPort: null,
  overrides: null,
  enabled: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const HOST: Host = {
  id: 'host-1',
  bindingId: BINDING.id,
  remark: 'Amsterdam',
  priority: 0,
  enabled: true,
  addressOverride: null,
  portOverride: null,
  sniOverride: null,
  hostHeaderOverride: null,
  pathOverride: null,
  fingerprintOverride: null,
  alpn: [],
  allowInsecure: false,
  securityLayer: 'default',
  disableForFormats: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** A second node, so a refetch can change `nodes.length` without touching the
 *  host, the binding or the profile this form is actually editing. */
const OTHER_NODE: Node = { ...NODE, id: 'node-2', name: 'fra-1', countryCode: 'de' };

function seed(nodes: Node[] = [NODE]) {
  listHosts.mockResolvedValue({ hosts: [HOST] });
  listBindings.mockResolvedValue({ bindings: [BINDING] });
  listProfiles.mockResolvedValue({ profiles: [PROFILE] });
  listNodes.mockResolvedValue({ nodes, total: nodes.length, page: 1, limit: 100 });
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/hosts/:id" element={<HostEditPage />} />
    </Routes>,
    { route: `/hosts/${HOST.id}` },
  );
}

async function nameField(): Promise<HTMLInputElement> {
  const el = await screen.findByLabelText('Name');
  return el as HTMLInputElement;
}

describe('HostEditPage seeding', () => {
  it('fills the form from the record it is editing', async () => {
    seed();
    renderPage();
    // The control on every case below: a page that never seeded would also
    // "not lose" what was typed, because nothing would have rendered.
    await waitFor(async () => expect((await nameField()).value).toBe('Amsterdam'));
  });

  it('keeps what the operator typed when the node list changes underneath', async () => {
    seed();
    const { user, queryClient } = renderPage();

    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Amsterdam'));

    await user.clear(field);
    await user.type(field, 'Amsterdam edge');
    expect((await nameField()).value).toBe('Amsterdam edge');

    // Exactly what `goneWhileEditing` does after a failed save, and what any
    // background refetch does when another admin adds or removes a node: the
    // list this form derives country and port from comes back different. The
    // host itself is untouched.
    seed([NODE, OTHER_NODE]);
    await queryClient.invalidateQueries({ queryKey: ['nodes'] });

    // The control for THIS case: the new list has to be in the cache and on
    // screen, or the assertion below is about a render that never happened.
    // Asked of the cache AND of the page - the second node's name appears in
    // the node picker, which is rendered from the same query the seed reads.
    await waitFor(() =>
      expect(queryClient.getQueryData<{ nodes: Node[] }>(['nodes'])?.nodes).toHaveLength(2),
    );
    await screen.findByText('fra-1');

    expect((await nameField()).value).toBe('Amsterdam edge');
  });

  it('still re-seeds when the record itself is saved elsewhere', async () => {
    seed();
    const { queryClient } = renderPage();
    await waitFor(async () => expect((await nameField()).value).toBe('Amsterdam'));

    // The other direction, and the reason the effect cannot simply run once:
    // a host whose stored `updatedAt` moved is a different record than the one
    // on screen, and the form must show what is stored.
    listHosts.mockResolvedValue({
      hosts: [{ ...HOST, remark: 'Amsterdam renamed', updatedAt: '2026-08-27T10:00:00.000Z' }],
    });
    await queryClient.invalidateQueries({ queryKey: ['hosts'] });

    await waitFor(async () => expect((await nameField()).value).toBe('Amsterdam renamed'));
  });
});
