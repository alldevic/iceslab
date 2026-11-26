// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import ru from '@/i18n/locales/ru';
import { createQueryWrapper } from '@/test/queryWrapper';

/*
 * Разновидность WireGuard в правиле выдачи (12.4): поле видно только при
 * формате wgconf, сбрасывается при смене формата, в списке правил видна меткой.
 */

const listSrrRules = vi.fn();
const updateSrrRule = vi.fn();

vi.mock('@/lib/domain/srr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domain/srr')>()),
  listSrrRules: (...a: unknown[]) => listSrrRules(...a),
  updateSrrRule: (...a: unknown[]) => updateSrrRule(...a),
}));

import { SrrPage } from './SrrPage';
import { SrrRulePage } from './SrrRulePage';

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

const RULE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'WireGuard',
  uaPattern: '(?i)wireguard',
  format: 'wgconf',
  proto: 'wireguard',
  priority: 65,
  enabled: true,
  createdAt: '2026-11-26T00:00:00.000Z',
  updatedAt: '2026-11-26T00:00:00.000Z',
};
const OTHER = { ...RULE, id: '22222222-2222-4222-8222-222222222222', name: 'Clash', format: 'mihomo', proto: null, priority: 40 };

const FIRST_RENDER = { timeout: 5000 };

function renderAt(path: string) {
  const { wrapper: Query } = createQueryWrapper();
  render(
    <Query>
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/subscription/delivery" element={<SrrPage />} />
              <Route path="/subscription/delivery/:id" element={<SrrRulePage />} />
            </Routes>
          </MemoryRouter>
        </MantineProvider>
      </I18nextProvider>
    </Query>,
  );
}

describe('правило выдачи: разновидность WireGuard', () => {
  it('в списке: метка только у правила wgconf с разновидностью', async () => {
    listSrrRules.mockResolvedValue({ rules: [RULE, OTHER] });
    renderAt('/subscription/delivery');
    const tags = await screen.findAllByTestId('srr-proto', {}, FIRST_RENDER);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toBe(at('delivery.proto.wireguard'));
  });

  it('на странице правила: поле видно при wgconf и пропадает при смене формата', async () => {
    listSrrRules.mockResolvedValue({ rules: [RULE, OTHER] });
    renderAt(`/subscription/delivery/${RULE.id}`);
    expect(await screen.findByText(at('delivery.fieldProto'), {}, FIRST_RENDER)).toBeTruthy();

    fireEvent.click(screen.getByText(at('formatName.mihomo')));
    await waitFor(() => expect(screen.queryByText(at('delivery.fieldProto'))).toBeNull());
  });

  it('смена формата сбрасывает разновидность в сохраняемом теле', async () => {
    listSrrRules.mockResolvedValue({ rules: [RULE, OTHER] });
    updateSrrRule.mockResolvedValue(RULE);
    renderAt(`/subscription/delivery/${RULE.id}`);
    await screen.findByText(at('delivery.fieldProto'), {}, FIRST_RENDER);
    fireEvent.click(screen.getByText(at('formatName.mihomo')));
    fireEvent.click(screen.getByText(at('common.save')));
    await waitFor(() => expect(updateSrrRule).toHaveBeenCalled());
    expect(updateSrrRule.mock.calls[0]![1]).toMatchObject({ format: 'mihomo', proto: null });
  });

  it('сервер без поля proto: поле не рисуется', async () => {
    const old: Record<string, unknown> = { ...RULE };
    delete old.proto;
    listSrrRules.mockResolvedValue({ rules: [old] });
    renderAt(`/subscription/delivery/${RULE.id}`);
    await screen.findByText(at('formatName.wgconf'), {}, FIRST_RENDER);
    expect(screen.queryByText(at('delivery.fieldProto'))).toBeNull();
  });
});
