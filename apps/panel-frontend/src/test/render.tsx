import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next, { type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { theme } from '@/app/theme';
import { PageMetaProvider } from '@/lib/ui/PageMetaProvider';
import ru from '@/i18n/locales/ru';
import en from '@/i18n/locales/en';
import { Boundary } from '@/test/Boundary';
import { resetCaught } from '@/test/screens';

/**
 * The provider stack of `app/main.tsx`, for a test: a QueryClient of its own
 * with retries off (a failing query fails the case instead of waiting), the
 * app theme, modals and notifications, a MemoryRouter at `route`, an i18n
 * instance in `lang`, and a render-error boundary around the lot.
 *
 * Not a `setupFiles` entry, and it does not install jsdom stubs itself: a file
 * that mounts has the `jsdom` docblock and calls `installJsdomStubs()` once.
 */

export type Lang = 'en' | 'ru';

/** Keys the dictionary of the render did not have, in the order asked. Cleared by `renderWithProviders`. */
export const missingKeys: string[] = [];

export function createI18n(lang: Lang): I18n {
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({
    lng: lang,
    fallbackLng: false,
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
    // Synchronous with inline resources: the first render already has words.
    initImmediate: false,
    saveMissing: true,
    missingKeyHandler: (_lngs, _ns, key) => {
      missingKeys.push(key);
    },
  });
  return i18n;
}

export interface RenderOptions {
  /** Where the MemoryRouter starts. */
  route?: string;
  lang?: Lang;
}

export function renderWithProviders(ui: ReactNode, opts: RenderOptions = {}) {
  const { route = '/', lang = 'en' } = opts;
  resetCaught();
  missingKeys.length = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const i18n = createI18n(lang);
  const result = render(
    <Boundary>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MantineProvider theme={theme} defaultColorScheme="dark" forceColorScheme="dark">
            <ModalsProvider>
              <Notifications />
              <MemoryRouter initialEntries={[route]}>
                <PageMetaProvider>{ui}</PageMetaProvider>
              </MemoryRouter>
            </ModalsProvider>
          </MantineProvider>
        </I18nextProvider>
      </QueryClientProvider>
    </Boundary>,
  );
  return { ...result, client, i18n };
}
