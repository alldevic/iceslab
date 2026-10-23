import { loadView } from '@/lib/ui/loadView';

/**
 * What saving the panel name sends (A-237).
 *
 *   null              nothing may be sent: the server's answer has not arrived
 *                     (failed or on its way) or the field is not seeded yet;
 *   { error: 'empty' } the field is empty: refused at the field in words;
 *   { write }          the trimmed name.
 *
 * The field is seeded from the server's answer. Without it the field was
 * empty, and an empty field used to save as «Iceslab»: one click wrote the
 * default over the operator's own name when /settings had failed. An empty
 * name is no longer read as «the default» at all.
 */
export type BrandNameSave = { write: { brandName: string } } | { error: 'empty' } | null;

export function brandNameSave(settings: { brandName?: string | null } | undefined, typed: string | null): BrandNameSave {
  if (!settings || typed === null) return null;
  const name = typed.trim();
  return name === '' ? { error: 'empty' } : { write: { brandName: name } };
}

/**
 * Whether the field says «cannot be empty» (A-237 tail): only once the
 * operator edited it. A panel without its own name seeds the field empty, and
 * the refusal used to show before any typing; untouched, the placeholder says
 * the default instead, and Save stays closed by `brandNameSave` either way.
 */
export function brandNameFieldError(save: BrandNameSave, touched: boolean): 'empty' | null {
  return touched && save !== null && 'error' in save ? save.error : null;
}

/**
 * A list card's state (A-241): «none» only when the list arrived empty.
 * A list that did not arrive is said with the server's words and a retry.
 */
export type ListState = 'loading' | 'failed' | 'empty' | 'list';

export function listState(q: { data: unknown; isError: boolean }, count: number): ListState {
  const view = loadView(q);
  if (view !== 'ready') return view;
  return count === 0 ? 'empty' : 'list';
}
