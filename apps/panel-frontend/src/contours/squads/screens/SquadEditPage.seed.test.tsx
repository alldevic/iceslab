// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import ru from '@/i18n/locales/ru';
import { createQueryWrapper } from '@/test/queryWrapper';
import type { Squad } from '@/lib/domain/squads';

/*
 * Заполнение формы сквада (f16-23). Каждый список на странице заменяет выдачу
 * целиком, пустой массив отзывает её, поэтому форма, не догнавшая запись,
 * хуже формы, которая отказывается сохранять. В базе защита устроена иначе, чем
 * в форке (там `seededId` и эффект): форма заполняется в рендере по ключу
 * `id:updatedAt`, а `seededId` закрывает кнопку, пока значения не этого сквада.
 * Утверждения выведены из поведения базы.
 */

const listSquads = vi.fn();
const updateSquad = vi.fn();

vi.mock('@/lib/domain/squads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/squads')>()),
  listSquads: () => listSquads(),
  updateSquad: (...a: unknown[]) => updateSquad(...a),
}));
// Everything else the page reads on mount: answered empty, so an empty screen
// cannot be a rejected request in disguise.
vi.mock('@/lib/domain/hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/hosts')>()),
  listHosts: vi.fn(async () => ({ hosts: [] })),
}));
vi.mock('@/lib/domain/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/profiles')>()),
  listBindings: vi.fn(async () => ({ bindings: [] })),
  listProfiles: vi.fn(async () => ({ profiles: [] })),
}));
vi.mock('@/lib/domain/nodes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/nodes')>()),
  listAllNodes: vi.fn(async () => ({ nodes: [], total: 0, page: 1, limit: 100 })),
}));
vi.mock('@/lib/domain/cascades', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/cascades')>()),
  listCascades: vi.fn(async () => ({ cascades: [] })),
}));
vi.mock('@/lib/domain/nodePolicies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/nodePolicies')>()),
  listNodePolicies: vi.fn(async () => ({ policies: [] })),
}));
vi.mock('@/lib/domain/routePolicies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/routePolicies')>()),
  listRoutePolicies: vi.fn(async () => ({ policies: [] })),
  listRoutingPresets: vi.fn(async () => ({ presets: [] })),
}));

import { SquadEditPage } from './SquadEditPage';

const i18n = i18next.createInstance();
const at = (key: string): string =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], ru) as string;

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'ru', resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  listSquads.mockReset();
  updateSquad.mockReset();
});
afterEach(cleanup);

function squad(over: Partial<Squad> & Pick<Squad, 'id' | 'name'>): Squad {
  return {
    description: null,
    profileIds: [],
    exitAcl: [],
    policyIds: [],
    hostIds: [],
    routingPreset: null,
    hwidDeviceLimit: null,
    memberCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

const ALPHA = squad({ id: 'squad-alpha', name: 'Alpha tier' });
const BETA = squad({ id: 'squad-beta', name: 'Beta tier' });

function renderAt(route: string) {
  const { client, wrapper: Query } = createQueryWrapper();
  const view = render(
    <Query>
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <MemoryRouter initialEntries={[route]}>
            {/* A way to walk between squads without remounting the router. */}
            <Link to="/squads/squad-beta">to-beta</Link>
            <Routes>
              <Route path="/squads/:id" element={<SquadEditPage />} />
              <Route path="/squads" element={<div>squads list</div>} />
            </Routes>
          </MemoryRouter>
        </MantineProvider>
      </I18nextProvider>
    </Query>,
  );
  return { client, ...view };
}

// The first render (Mantine, i18n, the router) can take over a second on a loaded machine.
const FIRST_RENDER = { timeout: 5000 };
const nameField = async () =>
  (await screen.findByLabelText(new RegExp(`^${at('squadEdit.name')}`), {}, FIRST_RENDER)) as HTMLInputElement;
const saveButton = async () => screen.findByRole('button', { name: at('common.save') });
const unsaved = () => screen.queryByText(at('squadEdit.unsaved'));

describe('SquadEditPage: заполнение формы', () => {
  it('заполняется сквадом из адреса после загрузки', async () => {
    // Контроль для остальных случаев: страница, которая не заполнилась, тоже
    // «не показывала бы чужой сквад».
    listSquads.mockResolvedValue({ squads: [ALPHA, BETA] });
    renderAt('/squads/squad-alpha');
    await waitFor(async () => expect((await nameField()).value).toBe('Alpha tier'), FIRST_RENDER);
    await waitFor(async () => expect((await saveButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('до загрузки сквада нечего сохранять: форма не нарисована', async () => {
    let resolve!: (v: { squads: Squad[] }) => void;
    listSquads.mockReturnValue(new Promise((r) => (resolve = r)));
    renderAt('/squads/squad-alpha');

    await screen.findByText(at('common.loading'));
    expect(screen.queryByRole('button', { name: at('common.save') })).toBeNull();
    expect(screen.queryByLabelText(new RegExp(`^${at('squadEdit.name')}`))).toBeNull();

    await act(async () => resolve({ squads: [ALPHA, BETA] }));
    await waitFor(async () => expect((await saveButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('говорит, что сквада нет, и даёт путь назад, когда список пришёл без него', async () => {
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    renderAt('/squads/squad-that-was-deleted');

    await screen.findByText(at('squadEdit.notFound'));
    expect(screen.queryByRole('button', { name: at('common.save') })).toBeNull();
    fireEvent.click(await screen.findByText(at('squadEdit.backToList')));
    await screen.findByText('squads list');
  });

  it('переход ко второму скваду перезаполняет форму его значениями', async () => {
    // Оба сквада в одном ответе: запись под смонтированной страницей меняется
    // без запроса между, и ключ заполнения обязан это заметить.
    listSquads.mockResolvedValue({ squads: [ALPHA, BETA] });
    renderAt('/squads/squad-alpha');
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Alpha tier'));
    fireEvent.change(field, { target: { value: 'Alpha typed' } });
    expect(unsaved()).not.toBeNull();

    fireEvent.click(screen.getByText('to-beta'));

    await waitFor(async () => expect((await nameField()).value).toBe('Beta tier'));
    expect(unsaved(), 'набранное в первом скваде не переходит на второй').toBeNull();
    await waitFor(async () => expect((await saveButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('фоновое обновление без смены updatedAt не затирает ввод и «не сохранено»', async () => {
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    const { client } = renderAt('/squads/squad-alpha');
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Alpha tier'));
    fireEvent.change(field, { target: { value: 'Alpha typed' } });

    // Тот же сквад, новый объект ответа, тот же updatedAt (фокус окна, опрос).
    listSquads.mockResolvedValue({ squads: [{ ...ALPHA }] });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['squads'] });
    });
    expect(listSquads).toHaveBeenCalledTimes(2);

    expect((await nameField()).value).toBe('Alpha typed');
    expect(unsaved()).not.toBeNull();
  });

  it('смена updatedAt (сохранён в другом месте) заполняет форму заново', async () => {
    listSquads.mockResolvedValue({ squads: [ALPHA] });
    const { client } = renderAt('/squads/squad-alpha');
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Alpha tier'));
    fireEvent.change(field, { target: { value: 'Alpha typed' } });

    listSquads.mockResolvedValue({
      squads: [{ ...ALPHA, name: 'Alpha renamed', updatedAt: '2026-08-27T10:00:00.000Z' }],
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['squads'] });
    });

    await waitFor(async () => expect((await nameField()).value).toBe('Alpha renamed'));
    expect(unsaved()).toBeNull();
  });

  it('сохранение неизменённой формы не шлёт списки: пустые массивы не становятся отзывом выдачи', async () => {
    const withGrants = squad({ id: 'squad-alpha', name: 'Alpha tier', profileIds: ['p1'], policyIds: ['pol1'] });
    listSquads.mockResolvedValue({ squads: [withGrants] });
    updateSquad.mockResolvedValue(withGrants);
    renderAt('/squads/squad-alpha');
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Alpha tier'));
    fireEvent.change(field, { target: { value: 'Alpha 2' } });
    fireEvent.click(await saveButton());

    await waitFor(() => expect(updateSquad).toHaveBeenCalledTimes(1));
    const [id, body] = updateSquad.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('squad-alpha');
    expect(body.name).toBe('Alpha 2');
    for (const k of ['profileIds', 'policyIds', 'hostIds', 'exitAcl']) {
      expect(body, `${k} untouched must not be sent`).not.toHaveProperty(k);
    }
  });
});
