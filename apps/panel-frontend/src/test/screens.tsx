import { Component, type ReactNode } from 'react';

/**
 * The two things every screen test needs before it can assert anything.
 *
 * Kept here rather than beside one of them because importing a symbol from a
 * `.test.tsx` re-runs that file's whole suite inside the importer.
 */

/**
 * React reports a render error to the nearest boundary and then unmounts the
 * tree. Without one, the throw surfaces as an unhandled rejection AFTER the
 * case has already passed — which is how the first sweep reported seventeen
 * green pages while one of them was crashing on its first render.
 *
 * `caught` is module state on purpose: a boundary cannot hand its error back
 * through props, and every case reads it immediately after its own mount.
 */
export let caught: Error | null = null;
export function resetCaught(): void {
  caught = null;
}

export class Boundary extends Component<{ children: ReactNode }> {
  componentDidCatch(err: Error) {
    caught = err;
  }
  render() {
    return this.props.children;
  }
}

/**
 * The text a reader sees.
 *
 * Mantine injects its whole theme as a `<style>` inside the container and its
 * 20 KB of CSS counts toward `textContent`, so without stripping it "the screen
 * rendered something" is true of a screen that rendered nothing. Stripped on a
 * CLONE: this runs inside `waitFor`, which retries, and removing nodes from the
 * live tree makes the second attempt throw `NotFoundError` at React instead of
 * reporting the assertion.
 */
export function visibleText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const style of Array.from(clone.querySelectorAll('style'))) style.remove();
  return clone.textContent ?? '';
}

/**
 * Cyrillic in a screen rendered in English.
 *
 * The panel ships `en` and `ru`, and the earlier i18n check compared the two
 * LOCALE FILES — which cannot see prose that never became a key. Two components
 * had nineteen such strings between them: an English operator read a "Закрыть"
 * button, a Russian one read English everywhere else in the same modal, and one
 * field description shipped the internal words "slice 30.1" to both.
 *
 * Asked in one direction only. English text inside a Russian render is ordinary
 * (protocol names, `geosite:`, `TLSv1.3`); Russian text inside an English one
 * is a string that never went through `t()`.
 */
export function cyrillicIn(text: string): string[] {
  return [...new Set(text.match(/[А-Яа-яЁё][А-Яа-яЁё\s.,·—-]*/g) ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}
