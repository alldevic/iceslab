// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import ru from '@/i18n/locales/ru';
import { createQueryWrapper } from '@/test/queryWrapper';

/*
 * Поле «Число входов» (f12-02): сервер принимает `subscriptionEntryPoolSize`
 * 0..64 (0 — все входы), а страница должна показать сохранённое значение и
 * отправить новое. Без поля настройка меняется только прямым запросом.
 */

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('@/lib/domain/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/settings')>()),
  getSettings: () => getSettings(),
  updateSettings: (...a: unknown[]) => updateSettings(...a),
}));

import { SubscriptionMetadataPage } from './SubscriptionMetadataPage';

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
  getSettings.mockReset();
  updateSettings.mockReset();
  updateSettings.mockResolvedValue({});
});
afterEach(cleanup);

function renderPage() {
  const { wrapper: Query } = createQueryWrapper();
  return render(
    <Query>
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <MemoryRouter>
            <SubscriptionMetadataPage />
          </MemoryRouter>
        </MantineProvider>
      </I18nextProvider>
    </Query>,
  );
}

const FIRST_RENDER = { timeout: 5000 };
const field = async () => (await screen.findByLabelText(at('metadata.entryPool'), {}, FIRST_RENDER)) as HTMLInputElement;

describe('SubscriptionMetadataPage: число входов', () => {
  it('показывает сохранённое значение', async () => {
    getSettings.mockResolvedValue({ subscriptionEntryPoolSize: 3 });
    renderPage();
    await waitFor(async () => expect((await field()).value).toBe('3'), FIRST_RENDER);
  });

  it('без сохранённого значения показывает 0: все входы', async () => {
    getSettings.mockResolvedValue({});
    renderPage();
    await waitFor(async () => expect((await field()).value).toBe('0'), FIRST_RENDER);
  });

  it('отправляет новое значение в запросе сохранения', async () => {
    getSettings.mockResolvedValue({ subscriptionEntryPoolSize: 3 });
    renderPage();
    const input = await field();
    await waitFor(() => expect(input.value).toBe('3'), FIRST_RENDER);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: at('common.save') }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({ subscriptionEntryPoolSize: 5 });
  });

  it('пустое поле уходит как 0, а не выпадает из запроса', async () => {
    getSettings.mockResolvedValue({ subscriptionEntryPoolSize: 3 });
    renderPage();
    const input = await field();
    await waitFor(() => expect(input.value).toBe('3'), FIRST_RENDER);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(await screen.findByRole('button', { name: at('common.save') }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({ subscriptionEntryPoolSize: 0 });
  });
});
