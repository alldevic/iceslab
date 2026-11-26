// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';

const { list, revoke, confirm } = vi.hoisted(() => ({
  list: vi.fn(),
  revoke: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@/lib/domain/users', () => ({ listUserWgDevices: list, revokeWgDevice: revoke }));
vi.mock('@/lib/auth/api', () => ({
  fetchAuthStatus: async () => ({ panel: { publicUrl: 'https://panel.test', subscriptionPathPrefix: '/sub' } }),
}));
vi.mock('@mantine/modals', () => ({ modals: { openConfirmModal: confirm } }));

import { WgDeviceList } from './WgDeviceList';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ru: { translation: ru } }, interpolation: { escapeValue: false } });
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  list.mockReset();
  revoke.mockReset().mockResolvedValue(undefined);
  confirm.mockReset();
});
afterEach(cleanup);

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <div data-testid="host">
            <WgDeviceList userId="u1" subscriptionToken="tok123" />
          </div>
        </MantineProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const dev = (index: number, over: object = {}) => ({
  id: `d${index}`, userId: 'u1', index, label: null, publicKey: `pk${index}`, addresses: [`10.66.66.${index + 1}`],
  bytesIn: '0', bytesOut: '0', lastSeenAt: null, createdAt: '2026-01-01T00:00:00Z', ...over,
});

describe('WgDeviceList', () => {
  it('draws nothing for a user with no WireGuard device (the card is as in the base)', async () => {
    list.mockResolvedValue({ devices: [] });
    mount();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('host').innerHTML).toBe('');
  });

  it('shows number, addresses, traffic, last use and a config link per device', async () => {
    list.mockResolvedValue({
      devices: [dev(1, { bytesIn: '2048', bytesOut: '1024', lastSeenAt: new Date().toISOString() }), dev(2)],
    });
    mount();
    expect(await screen.findByText('#1')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('10.66.66.2')).toBeTruthy();
    expect(screen.getByText('never connected')).toBeTruthy();
    const links = await waitFor(() => {
      const a = screen.getAllByText('config').map((e) => e.getAttribute('href'));
      expect(a).toHaveLength(2);
      return a;
    });
    expect(links[1]).toBe('https://panel.test/sub/tok123?format=wgconf&device=2&dl=1');
  });

  it('revokes only after the confirmation, then asks the list again', async () => {
    list.mockResolvedValue({ devices: [dev(1), dev(2)] });
    mount();
    await screen.findByText('#2');
    fireEvent.click(screen.getAllByLabelText('Revoke')[1]!);
    expect(revoke).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mock.calls[0]![0].onConfirm();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('d2'));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
  });
});
