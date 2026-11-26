// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import ru from '@/i18n/locales/ru';
import { createQueryWrapper } from '@/test/queryWrapper';

/*
 * Заполнение формы хоста (f16-14). Форма берёт порт, страну и ноду из списков
 * привязок и нод, поэтому ждёт их ответа, но после заполнения длины списков её
 * не трогают: иначе фоновое обновление списка стирает набранное и `dirty`.
 * Заново форма заполняется только когда сменился сам хост (id или updatedAt).
 */

const listHosts = vi.fn();
const listBindings = vi.fn();
const listAllNodes = vi.fn();
const listProfiles = vi.fn();

vi.mock('@/lib/domain/hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/hosts')>()),
  listHosts: (...a: unknown[]) => listHosts(...a),
  getHostFreshness: vi.fn(async () => ({ configChangedAt: '2026-08-01T00:00:00.000Z', current: 0, stale: 0, total: 0, neverFetched: 0 })),
}));
vi.mock('@/lib/domain/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/profiles')>()),
  listBindings: (...a: unknown[]) => listBindings(...a),
  listProfiles: (...a: unknown[]) => listProfiles(...a),
  // «Нет мнения» это документированный ответ: поля остаются видимыми.
  getProfileHostFields: vi.fn(async () => ({ fields: {} })),
}));
vi.mock('@/lib/domain/nodes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/nodes')>()),
  listAllNodes: (...a: unknown[]) => listAllNodes(...a),
}));

import { HostEditPage } from './HostEditPage';

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
afterEach(cleanup);

const NODE = { id: 'node-1', name: 'ams-1', address: '203.0.113.10', countryCode: 'nl', status: 'online' };
const OTHER_NODE = { ...NODE, id: 'node-2', name: 'fra-1', countryCode: 'de' };
const PROFILE = { id: 'profile-1', name: 'vless-reality', protocol: 'xray', enabled: true, config: {} };
const BINDING = { id: 'binding-1', profileId: PROFILE.id, nodeId: NODE.id, port: 443, enabled: true };
const HOST = {
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

function answer(nodes: unknown[] = [NODE], bindings: unknown[] = [BINDING]) {
  listHosts.mockResolvedValue({ hosts: [HOST] });
  listBindings.mockResolvedValue({ bindings });
  listProfiles.mockResolvedValue({ profiles: [PROFILE] });
  listAllNodes.mockResolvedValue({ nodes, total: nodes.length, page: 1, limit: 100 });
}

function renderPage() {
  const { client, wrapper: Query } = createQueryWrapper();
  render(
    <Query>
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <MemoryRouter initialEntries={[`/hosts/${HOST.id}`]}>
            <Routes>
              <Route path="/hosts/:id" element={<HostEditPage />} />
            </Routes>
          </MemoryRouter>
        </MantineProvider>
      </I18nextProvider>
    </Query>,
  );
  return client;
}

// The first render (Mantine, i18n, the router) can take over a second on a loaded machine.
const FIRST_RENDER = { timeout: 5000 };
const nameField = async () =>
  (await screen.findByLabelText(at('hostEdit.name'), {}, FIRST_RENDER)) as HTMLInputElement;

describe('HostEditPage: заполнение формы', () => {
  it('заполняется записью хоста после ответа хоста и списков', async () => {
    answer();
    renderPage();
    // Контроль для остальных случаев: страница, которая не заполнилась, тоже
    // «не теряла» бы набранное.
    await waitFor(async () => expect((await nameField()).value).toBe('Amsterdam'), FIRST_RENDER);
  });

  it('повторная выдача списка нод другой длины не меняет введённое и не сбрасывает «не сохранено»', async () => {
    answer();
    const client = renderPage();
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Amsterdam'));

    fireEvent.change(field, { target: { value: 'Amsterdam edge' } });
    expect((await nameField()).value).toBe('Amsterdam edge');
    expect(screen.getByText(at('squadEdit.unsaved'))).toBeTruthy();

    // То, что делает `goneWhileEditing` после неудачного сохранения и любое
    // фоновое обновление: список нод пришёл другой длины, хост не тронут.
    answer([NODE, OTHER_NODE]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['nodes'] });
    });
    // Контроль: новый список действительно в кэше.
    await waitFor(() =>
      expect(client.getQueryData<{ nodes: unknown[] }>(['nodes'])?.nodes).toHaveLength(2),
    );

    expect((await nameField()).value).toBe('Amsterdam edge');
    expect(screen.getByText(at('squadEdit.unsaved'))).toBeTruthy();
  });

  it('то же для списка привязок другой длины', async () => {
    answer();
    const client = renderPage();
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Amsterdam'));
    fireEvent.change(field, { target: { value: 'Amsterdam edge' } });

    answer([NODE], [BINDING, { ...BINDING, id: 'binding-2', port: 8443 }]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['bindings'] });
    });
    await waitFor(() =>
      expect(client.getQueryData<{ bindings: unknown[] }>(['bindings'])?.bindings).toHaveLength(2),
    );

    expect((await nameField()).value).toBe('Amsterdam edge');
    expect(screen.getByText(at('squadEdit.unsaved'))).toBeTruthy();
  });

  it('смена updatedAt хоста заполняет форму заново', async () => {
    answer();
    const client = renderPage();
    const field = await nameField();
    await waitFor(() => expect(field.value).toBe('Amsterdam'));
    fireEvent.change(field, { target: { value: 'Amsterdam edge' } });

    // Хост сохранён в другом месте: на экране должно быть то, что хранится.
    listHosts.mockResolvedValue({
      hosts: [{ ...HOST, remark: 'Amsterdam renamed', updatedAt: '2026-08-27T10:00:00.000Z' }],
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['hosts'] });
    });

    await waitFor(async () => expect((await nameField()).value).toBe('Amsterdam renamed'));
    expect(screen.queryByText(at('squadEdit.unsaved'))).toBeNull();
  });
});
