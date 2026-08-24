import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { theme } from '../theme';
import i18n from '../i18n';

/**
 * The provider stack the app mounts in main.tsx, minus BrowserRouter (a test
 * has no address bar) and with a QueryClient built per render.
 *
 * The list is deliberately the same and in the same order: a component that
 * reads a Mantine theme value or opens a `modals.openConfirmModal` behaves
 * differently under a partial stack, and a component test that renders a
 * different tree than production is a test of nothing.
 *
 * i18n is the app's real instance, not a mock. Translations are part of what
 * the component renders - a validator whose message key does not resolve shows
 * `profiles.form.cfg.pqNeedsSeed` to the operator, and a test that asserted on
 * a stubbed `t` would call that a pass.
 */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A test should fail on the first bad response, not four seconds later
      // after three silent retries; and cached data must not leak between
      // tests through a shared client.
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entries for the MemoryRouter. */
  route?: string;
  /** Reuse a client across renders when a test needs to seed the cache. */
  queryClient?: QueryClient;
  /** 'ru' is the app's fallback; tests assert against 'en' unless told otherwise. */
  language?: 'ru' | 'en';
  /**
   * Mantine's own testing switch. jsdom fires no `transitionend`, so a
   * `Collapse` opened by a click keeps `display: none` forever and everything
   * inside it stays invisible to a role query - which reads as "the section has
   * no tabs" rather than as "the animation never finished". `env="test"`
   * settles transitions immediately. Pass 'default' to test the animated
   * behaviour itself.
   */
  env?: 'default' | 'test';
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const {
    route = '/',
    queryClient = makeQueryClient(),
    language = 'en',
    env = 'test',
    ...rest
  } = options;

  // Synchronous because the resources are bundled in i18n/index.ts; nothing is
  // fetched, so the change is in effect by the time render() runs.
  void i18n.changeLanguage(language);

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark" env={env}>
        <ModalsProvider>
          <Notifications />
          <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  );

  return {
    ...render(ui, { wrapper: Wrapper, ...rest }),
    queryClient,
    user: userEvent.setup(),
  };
}

export * from '@testing-library/react';
