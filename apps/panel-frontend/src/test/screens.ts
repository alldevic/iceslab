import en from '@/i18n/locales/en';

/**
 * The things every screen test needs before it can assert anything. Not a
 * `.test.tsx`: importing a symbol from one re-runs its whole suite in the
 * importer.
 */

/**
 * React reports a render error to the nearest boundary (`test/Boundary.tsx`) and then unmounts the
 * tree. Without one the throw surfaces as an unhandled rejection after the case
 * has already passed.
 *
 * `caught` is module state on purpose: a boundary cannot hand its error back
 * through props, and every case reads it right after its own mount.
 */
export let caught: Error | null = null;
export function resetCaught(): void {
  caught = null;
}
export function setCaught(err: Error): void {
  caught = err;
}

/**
 * The text a reader sees. Mantine injects its theme as a `<style>` inside the
 * container, and 20 KB of CSS counts toward `textContent`, so without
 * stripping it "the screen rendered something" is true of a blank one.
 * Stripped on a CLONE: this runs inside `waitFor`, which retries, and removing
 * nodes from the live tree makes the second attempt throw at React.
 */
export function visibleText(root: HTMLElement, separator = ''): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const style of Array.from(clone.querySelectorAll('style, script'))) style.remove();
  if (!separator) return clone.textContent ?? '';
  // One string per text node: a scan for key-shaped words must not glue the end
  // of a sentence ("engine.") to the label that follows it ("Address").
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue ?? '');
  return parts.join(separator);
}

/** The one Russian word an English screen is allowed: the language switch names itself. */
const ALLOWED_CYRILLIC = new Set(['Русский']);

/**
 * Cyrillic in a screen rendered in English. Asked in one direction only:
 * English inside a Russian render is ordinary (protocol names, `geosite:`),
 * Russian inside an English one is a string that never went through `t()`.
 */
export function cyrillicIn(text: string): string[] {
  return [...new Set(text.match(/[А-Яа-яЁё][А-Яа-яЁё\s.,·—-]*/g) ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !ALLOWED_CYRILLIC.has(s));
}

const TOP_KEYS = new Set(Object.keys(en));

/**
 * Strings that look like a locale key shown as text: i18next answers a missing
 * key with the key itself. Matched by the first segment being a real top-level
 * section of `en`, so `example.com` and `1.2.3` are not flagged and `a.b.c`
 * shaped words that are not keys do not pass for ones.
 */
export function rawKeysIn(text: string): string[] {
  const found = text.match(/\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+\b/g) ?? [];
  return [...new Set(found.filter((s) => TOP_KEYS.has(s.split('.')[0])))];
}

/** A defect a mounted screen shows today, listed by name in the table of the test that found it. */
export interface KnownException {
  /** Table row it belongs to. */
  name: string;
  cyrillic?: string[];
  rawKeys?: string[];
  /** Why it is not fixed here, with the task that will. */
  task: string;
}

/**
 * What is wrong with a mounted screen's text, minus the listed exceptions.
 * Returns problems as strings so one `expect(problems).toEqual([])` prints all.
 */
export function textProblems(name: string, text: string, known: KnownException[]): string[] {
  const own = known.find((k) => k.name === name);
  const cyr = cyrillicIn(text).filter((s) => !own?.cyrillic?.includes(s));
  const keys = rawKeysIn(text).filter((s) => !own?.rawKeys?.includes(s));
  const stale = [
    ...(own?.cyrillic ?? []).filter((s) => !cyrillicIn(text).includes(s)).map((s) => `stale exception (cyrillic) ${JSON.stringify(s)}`),
    ...(own?.rawKeys ?? []).filter((s) => !rawKeysIn(text).includes(s)).map((s) => `stale exception (raw key) ${s}`),
  ];
  return [
    ...cyr.map((s) => `cyrillic in English UI: ${JSON.stringify(s)}`),
    ...keys.map((s) => `raw locale key shown: ${s}`),
    ...stale,
  ];
}
