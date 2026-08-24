import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * jsdom implements no layout, and Mantine asks for the two APIs that report it
 * on almost every component it renders. Neither exists in jsdom, and the
 * failure is a bare `matchMedia is not a function` from inside a provider,
 * which says nothing about the component under test - so they are stubbed once
 * here rather than per file.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

/** Mantine's Popover/Select measure through this; jsdom has it only in v24+. */
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

/**
 * `restoreMocks` in the vitest config resets spies, not the DOM. Without an
 * explicit cleanup every render stays mounted for the rest of the file and
 * queries start matching the previous test's tree - which shows up as a test
 * that passes for the wrong reason, not as a failure.
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
