import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Minimal provider wrapper for hook and page tests: a fresh QueryClient with
 * retries off, so a failing query fails the test instead of waiting.
 * Returns the client too, so the test can read or spy on the cache.
 */
export function createQueryWrapper(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}
