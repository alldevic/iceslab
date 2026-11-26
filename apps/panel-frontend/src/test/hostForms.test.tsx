// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { CreateHostSchema, UpdateHostSchema } from '@backend/modules/hosts/hosts.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, sameWhereSent, theWrite } from '@/test/formDrive';
import { nodeRecord, profileRecord } from '@/test/records';
import { HostEditPage } from '@/contours/hosts/screens/HostEditPage';
import type { Host } from '@/lib/domain/hosts';
import type { Binding } from '@/lib/domain/profiles';

/*
 * The host screen against CreateHostSchema / UpdateHostSchema (milestone 17.5):
 * mounted, filled and saved. The create form is reached the way the profile
 * card reaches it, with `?profileId=&nodeId=` in the address.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

const T0 = '2026-08-01T00:00:00.000Z';
const NODE_ID = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '55555555-5555-4555-8555-555555555555';
const BINDING_ID = '66666666-6666-4666-8666-666666666666';
const HOST_ID = '77777777-7777-4777-8777-777777777777';

const node = nodeRecord({ id: NODE_ID, name: 'ams-1', address: '203.0.113.10:8443', countryCode: 'NL' });
const profile = profileRecord({ id: PROFILE_ID, name: 'vless-reality' });
const binding: Binding = {
  id: BINDING_ID,
  profileId: PROFILE_ID,
  nodeId: NODE_ID,
  port: 443,
  publicHost: null,
  publicPort: null,
  overrides: null,
  enabled: true,
  createdAt: T0,
  updatedAt: T0,
};
const host = (over: Partial<Host> = {}): Host => ({
  id: HOST_ID,
  bindingId: BINDING_ID,
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
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const FIRST = { timeout: 5000 };

function mount(route: string, hosts: Host[]) {
  const api = installEmptyApi({
    routes: [
      { re: /^\/api\/hosts$/, reply: { hosts } },
      { re: /^\/api\/bindings$/, reply: { bindings: [binding] } },
      { re: /^\/api\/nodes$/, reply: { nodes: [node], total: 1, page: 1, limit: 100, fields: [] } },
      { re: /^\/api\/profiles$/, reply: { profiles: [profile] } },
      { re: /^\/api\/hosts\/[^/]+\/freshness$/, reply: { configChangedAt: T0, current: 0, stale: 0, total: 0, neverFetched: 0 } },
    ],
    onWrite: (r) =>
      r.url === '/api/hosts' && r.method === 'POST' ? { data: host() } : r.method === 'PUT' ? { data: hosts[0] } : undefined,
  });
  const view = renderWithProviders(
    <Routes>
      <Route path="/hosts/:id" element={<HostEditPage />} />
    </Routes>,
    { route },
  );
  return { api, view };
}

type View = ReturnType<typeof mount>['view'];
const field = async (view: View, key: string) => (await screen.findByLabelText(new RegExp(`^${view.i18n.t(key)}`), {}, FIRST)) as HTMLInputElement;

describe('host create, name, profile, node and port only', () => {
  it('the request of the default form passes CreateHostSchema', async () => {
    window.history.replaceState({}, '', `/hosts/new?profileId=${PROFILE_ID}&nodeId=${NODE_ID}`);
    const { api, view } = mount('/hosts/new', []);
    fireEvent.change(await field(view, 'hostEdit.name'), { target: { value: 'Amsterdam' } });
    fireEvent.change(await field(view, 'hostEdit.port'), { target: { value: '443' } });
    const create = (await screen.findByRole('button', { name: view.i18n.t('hostEdit.create') })) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false), FIRST);
    fireEvent.click(create);
    await waitFor(() => theWrite(api.calls, 'POST', '/api/hosts'));
    const body = theWrite(api.calls, 'POST', '/api/hosts').body;
    const parsed = accepted(CreateHostSchema, body);
    expect(parsed).toMatchObject({ profileId: PROFILE_ID, nodeId: NODE_ID, port: 443, remark: 'Amsterdam' });
  });
});

describe('host edit, opened on a stored host', () => {
  const RICH = host({
    addressOverride: 'edge.example.test',
    portOverride: 8443,
    sniOverride: 'sni.example.test',
    hostHeaderOverride: 'h.example.test',
    pathOverride: '/ws',
    fingerprintOverride: 'chrome',
    alpn: ['h2', 'http/1.1'],
    securityLayer: 'tls',
    disableForFormats: ['clash'],
    priority: 5,
  });

  async function saveAfterRename(stored: Host) {
    const { api, view } = mount(`/hosts/${stored.id}`, [stored]);
    const name = await field(view, 'hostEdit.name');
    await waitFor(() => expect(name.value).toBe(stored.remark), FIRST);
    fireEvent.change(name, { target: { value: 'Renamed' } });
    const save = (await screen.findByRole('button', { name: view.i18n.t('common.save') })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), FIRST);
    fireEvent.click(save);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/hosts/${stored.id}`));
    return theWrite(api.calls, 'PUT', `/api/hosts/${stored.id}`).body as Record<string, unknown>;
  }

  it('a host with nothing overridden: one change, the request passes UpdateHostSchema', async () => {
    const stored = host();
    const body = await saveAfterRename(stored);
    accepted(UpdateHostSchema, body);
    expect(body.remark).toBe('Renamed');
    sameWhereSent(body, stored as unknown as Record<string, unknown>, ['remark']);
  });

  it('a host with every override set comes back with the same overrides', async () => {
    const body = await saveAfterRename(RICH);
    accepted(UpdateHostSchema, body);
    // Not vacuous: the overrides are in the request, then compared with the stored ones.
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['addressOverride', 'sniOverride', 'hostHeaderOverride', 'pathOverride', 'fingerprintOverride', 'alpn', 'securityLayer', 'disableForFormats']));
    sameWhereSent(body, RICH as unknown as Record<string, unknown>, ['remark']);
    // The listen port is not restated: it would read as a move of the inbound.
    expect(body).not.toHaveProperty('port');
    // Nor is the client port: an override equal to the stored one is no change.
    expect(body).not.toHaveProperty('portOverride');
  });
});
