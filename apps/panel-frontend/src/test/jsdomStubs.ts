/**
 * What jsdom lacks and Mantine asks for, and the one build-time constant the
 * screens read (`__APP_VERSION__`, a `define` of `vite.config.ts` that the test
 * config does not repeat). A function, not a `setupFiles` entry:
 * a setup file would run in every test file, including the `node`-environment
 * ones that have no `window` (and the point of the default environment is that
 * they pay nothing for a DOM). The file that mounts calls this itself.
 */
export function installJsdomStubs(): void {
  (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= '0.0.0-test';

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

  Element.prototype.scrollIntoView ??= () => {};
  window.scrollTo ??= (() => {}) as typeof window.scrollTo;
}
