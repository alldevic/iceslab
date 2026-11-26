// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { CreateSquadSchema, UpdateSquadSchema } from '@backend/modules/squads/squads.schemas';
import { installEmptyApi } from '@/test/emptyApi';
import { installJsdomStubs } from '@/test/jsdomStubs';
import { renderWithProviders } from '@/test/render';
import { accepted, sameWhereSent, theWrite } from '@/test/formDrive';
import { SquadEditPage } from '@/contours/squads/screens/SquadEditPage';
import type { Squad } from '@/lib/domain/squads';

/*
 * The squad screen against CreateSquadSchema / UpdateSquadSchema (milestone
 * 17.5). The request is built inside the screen, so the screen is mounted and
 * driven the way an operator does it: type, press the button.
 */

beforeAll(() => installJsdomStubs());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SQUAD_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-08-01T00:00:00.000Z';

const squad = (over: Partial<Squad> = {}): Squad => ({
  id: SQUAD_ID,
  name: 'Alpha tier',
  description: null,
  profileIds: [],
  exitAcl: [],
  policyIds: [],
  hostIds: [],
  routingPreset: null,
  hwidDeviceLimit: null,
  memberCount: 0,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

function mount(route: string, stored: Squad[]) {
  const api = installEmptyApi({
    routes: [{ re: /^\/api\/squads$/, reply: { squads: stored } }],
    onWrite: (r) =>
      r.method === 'POST' && r.url === '/api/squads'
        ? { data: squad({ id: SQUAD_ID }) }
        : r.method === 'PUT'
          ? { data: stored[0] }
          : undefined,
  });
  const view = renderWithProviders(
    <Routes>
      <Route path="/squads/:id" element={<SquadEditPage />} />
    </Routes>,
    { route },
  );
  return { api, view };
}

const FIRST = { timeout: 5000 };
const t = (view: ReturnType<typeof mount>['view'], key: string) => view.i18n.t(key);

describe('squad create, name only', () => {
  it('the request of the default form passes CreateSquadSchema', async () => {
    const { api, view } = mount('/squads/new', []);
    const name = (await screen.findByLabelText(new RegExp(`^${t(view, 'squadEdit.name')}`), {}, FIRST)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Trial' } });
    const create = await screen.findByRole('button', { name: t(view, 'squads.create') });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => theWrite(api.calls, 'POST', '/api/squads'));
    const parsed = accepted(CreateSquadSchema, theWrite(api.calls, 'POST', '/api/squads').body);
    expect(parsed.name).toBe('Trial');
  });
});

describe('squad edit, opened on a stored squad', () => {
  async function open(stored: Squad) {
    const m = mount(`/squads/${stored.id}`, [stored]);
    const name = (await screen.findByLabelText(new RegExp(`^${t(m.view, 'squadEdit.name')}`), {}, FIRST)) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe(stored.name), FIRST);
    return { ...m, name };
  }
  const save = (view: ReturnType<typeof mount>['view']) => screen.findByRole('button', { name: t(view, 'common.save') });

  const STORED = squad({
    description: 'for the paying',
    profileIds: [PROFILE],
    policyIds: [],
    routingPreset: 'ru-split',
    hwidDeviceLimit: 3,
  });

  it('one field changed: the request passes UpdateSquadSchema and sends no list that was not touched', async () => {
    const { api, view, name } = await open(STORED);
    fireEvent.change(name, { target: { value: 'Alpha renamed' } });
    const btn = (await save(view)) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/squads/${SQUAD_ID}`));
    const body = theWrite(api.calls, 'PUT', `/api/squads/${SQUAD_ID}`).body as Record<string, unknown>;
    accepted(UpdateSquadSchema, body);
    expect(body.name).toBe('Alpha renamed');
    for (const k of ['profileIds', 'policyIds', 'hostIds', 'exitAcl']) expect(body, `${k} was not touched`).not.toHaveProperty(k);
    // What the stored squad had, and the form did not change, is not rewritten.
    sameWhereSent(body, STORED as unknown as Record<string, unknown>, ['name']);
  });

  it('a squad with nothing set (the nulls of the record) saves the same nulls', async () => {
    const { api, view, name } = await open(squad());
    fireEvent.change(name, { target: { value: 'Alpha 2' } });
    const btn = (await save(view)) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => theWrite(api.calls, 'PUT', `/api/squads/${SQUAD_ID}`));
    const body = theWrite(api.calls, 'PUT', `/api/squads/${SQUAD_ID}`).body as Record<string, unknown>;
    accepted(UpdateSquadSchema, body);
    sameWhereSent(body, squad() as unknown as Record<string, unknown>, ['name']);
  });
});
