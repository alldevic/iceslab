// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { CreateSrrSchema, UpdateSrrSchema } from '@backend/modules/srr/srr.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, sameWhereSent, theWrite } from '@/test/formDrive';
import { SrrRulePage } from '@/contours/subscription/screens/SrrRulePage';
import type { SrrRule } from '@/lib/domain/srr';

/*
 * The delivery-rule screen against CreateSrrSchema / UpdateSrrSchema
 * (milestone 17.5). The subscription-metadata screen and the settings screen
 * are in settingsForms.test.tsx.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RULE_ID = '88888888-8888-4888-8888-888888888888';
const T0 = '2026-08-01T00:00:00.000Z';
const rule = (over: Partial<SrrRule> = {}): SrrRule => ({
  id: RULE_ID,
  name: 'Clash clients',
  uaPattern: 'clash|mihomo',
  format: 'mihomo' as SrrRule['format'],
  priority: 40,
  enabled: true,
  templateName: null,
  proto: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const FIRST = { timeout: 5000 };

function mount(route: string, rules: SrrRule[]) {
  const api = installEmptyApi({
    routes: [{ re: /^\/api\/srr$/, reply: { rules } }],
    onWrite: (r) => (r.url === '/api/srr' && r.method === 'POST' ? { data: rule() } : r.method === 'PUT' ? { data: rules[0] } : undefined),
  });
  const view = renderWithProviders(
    <Routes>
      <Route path="/subscription/delivery/new" element={<SrrRulePage />} />
      <Route path="/subscription/delivery/:id" element={<SrrRulePage />} />
      <Route path="/subscription/delivery" element={<div>list</div>} />
    </Routes>,
    { route },
  );
  return { api, view };
}
type View = ReturnType<typeof mount>['view'];
const labelled = async (view: View, key: string) => (await screen.findByLabelText(view.i18n.t(key), {}, FIRST)) as HTMLInputElement;

describe('delivery rule create, name and pattern only', () => {
  it('the request of the default form passes CreateSrrSchema', async () => {
    const { api, view } = mount('/subscription/delivery/new', []);
    fireEvent.change(await labelled(view, 'delivery.fieldName'), { target: { value: 'Everything else' } });
    fireEvent.change(await labelled(view, 'delivery.fieldPattern'), { target: { value: '.*' } });
    const create = (await screen.findByRole('button', { name: view.i18n.t('delivery.create') })) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false), FIRST);
    fireEvent.click(create);
    await waitFor(() => theWrite(api.calls, 'POST', '/api/srr'));
    const parsed = accepted(CreateSrrSchema, theWrite(api.calls, 'POST', '/api/srr').body);
    expect(parsed).toMatchObject({ name: 'Everything else', uaPattern: '.*', format: 'plain', priority: 100, enabled: true });
  });
});

describe('delivery rule edit, opened on a stored rule', () => {
  async function renameAndSave(stored: SrrRule) {
    const { api, view } = mount(`/subscription/delivery/${stored.id}`, [stored]);
    const name = await labelled(view, 'delivery.fieldName');
    await waitFor(() => expect(name.value).toBe(stored.name), FIRST);
    fireEvent.change(name, { target: { value: 'Renamed' } });
    const save = (await screen.findByRole('button', { name: view.i18n.t('common.save') })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), FIRST);
    fireEvent.click(save);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/srr/${stored.id}`));
    return theWrite(api.calls, 'PUT', `/api/srr/${stored.id}`).body as Record<string, unknown>;
  }

  it.each([
    ['a plain rule', rule()],
    ['a disabled rule at the edge of the priority range', rule({ enabled: false, priority: 10000, uaPattern: '^Hiddify' })],
    ['a wgconf rule with its flavour', rule({ format: 'wgconf' as SrrRule['format'], proto: 'amneziawg', uaPattern: 'wireguard' })],
    ['a rule with a template of its own', rule({ templateName: 'my-template' })],
  ])('%s: renamed, the request passes UpdateSrrSchema and restates what was stored', async (_n, stored) => {
    const body = await renameAndSave(stored);
    accepted(UpdateSrrSchema, body);
    expect(body.name).toBe('Renamed');
    expect(body).toMatchObject({ uaPattern: stored.uaPattern, format: stored.format, priority: stored.priority, enabled: stored.enabled });
    sameWhereSent(body, stored as unknown as Record<string, unknown>, ['name']);
  });
});
