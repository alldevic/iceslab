import { GEO_COMPOSITE_CATEGORY_NAME, GEO_COMPOSITE_LIMITS } from '@iceslab/shared';
import type { GeoCompositeCategory, GeoCompositeRef } from '@iceslab/shared';
import type { GeoSet, GeoSetKind } from '@/lib/domain/geoSets';

/**
 * Редактор категорий составного гео-набора (веха 10.3): логика отдельно от
 * экрана, как у `geoTagHint.ts`. Сервер (веха 10.2) проверяет всё по-настоящему;
 * здесь только очевидное, чтобы не гонять запрос ради пустого имени, и разбор
 * его отказа обратно в черновик.
 */

/** Категория в редакторе: ручные записи и исключения пока одним текстом. */
export interface CategoryDraft {
  /** Для React: имя можно править, поэтому ключом оно быть не может. */
  key: string;
  name: string;
  enabled: boolean;
  refs: GeoCompositeRef[];
  manualText: string;
  excludeText: string;
}

let nextKey = 0;
export function newDraft(name = ''): CategoryDraft {
  nextKey += 1;
  return { key: `c${nextKey}`, name, enabled: true, refs: [], manualText: '', excludeText: '' };
}

export function draftFromCategory(c: GeoCompositeCategory): CategoryDraft {
  return { ...newDraft(c.name), enabled: c.enabled, refs: c.refs.map((r) => ({ ...r })), manualText: c.manual.join('\n'), excludeText: c.exclude.join('\n') };
}

/** Текст поля в записи: по строке на запись, края и пустые строки отбрасываются. Повторы сервер уберёт сам. */
export function parseEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Определение для отправки. Порядок категорий и записей сохраняется. */
export function buildDefinition(drafts: readonly CategoryDraft[]): GeoCompositeCategory[] {
  return drafts.map((d) => ({
    name: d.name.trim(),
    refs: d.refs.map((r) => ({ set: r.set, tag: r.tag })),
    manual: parseEntries(d.manualText),
    exclude: parseEntries(d.excludeText),
    enabled: d.enabled,
  }));
}

export type DraftProblem =
  | 'name-empty'
  | 'name-shape'
  | 'name-twice'
  | 'ref-self'
  | 'ref-incomplete'
  | 'ref-twice'
  | 'too-many';

/** Что не так у категории, по ключу черновика. Пусто = локально всё в порядке. */
export function checkDrafts(selfName: string, drafts: readonly CategoryDraft[]): Map<string, DraftProblem[]> {
  const out = new Map<string, DraftProblem[]>();
  const counts = new Map<string, number>();
  for (const d of drafts) counts.set(d.name.trim(), (counts.get(d.name.trim()) ?? 0) + 1);
  for (const d of drafts) {
    const name = d.name.trim();
    const p: DraftProblem[] = [];
    if (name === '') p.push('name-empty');
    else if (!GEO_COMPOSITE_CATEGORY_NAME.test(name)) p.push('name-shape');
    else if ((counts.get(name) ?? 0) > 1) p.push('name-twice');
    if (selfName !== '' && d.refs.some((r) => r.set === selfName)) p.push('ref-self');
    if (d.refs.some((r) => r.set === '' || r.tag === '')) p.push('ref-incomplete');
    const refKeys = d.refs.map((r) => `${r.set}:${r.tag.toLowerCase()}`);
    if (new Set(refKeys).size !== refKeys.length) p.push('ref-twice');
    if (d.refs.length > GEO_COMPOSITE_LIMITS.refs) p.push('too-many');
    if (p.length > 0) out.set(d.key, p);
  }
  return out;
}

/** Без локальных ошибок и хотя бы с одной категорией. */
export function definitionReady(selfName: string, drafts: readonly CategoryDraft[]): boolean {
  return drafts.length > 0 && drafts.length <= GEO_COMPOSITE_LIMITS.categories && checkDrafts(selfName, drafts).size === 0;
}

/**
 * Наборы, из которых можно брать категории: тот же вид, не составные (составной
 * не ссылается на составной, решение 10.2), не сам набор. Без проверенной
 * версии набор остаётся в списке: у него нет тегов, и редактор так и скажет.
 */
export function sourceChoices(sets: Iterable<GeoSet>, kind: GeoSetKind, selfName = ''): GeoSet[] {
  return [...sets].filter((s) => s.kind === kind && s.source.type !== 'composite' && s.name !== selfName);
}

/**
 * Куда в черновике указывает отказ сервера: категория по имени (`at.category`),
 * запись по тексту (`at.entry`). Ссылка на источник приходит как `набор:тег`,
 * ручная запись или исключение как есть. Категории с таким именем нет (ошибка
 * всего определения) -> `null`, и текст показывается общим.
 */
export interface DraftFault {
  key: string;
  field: 'ref' | 'manual' | 'exclude' | 'name' | null;
  entry: string | null;
}

export function locateRefusal(
  drafts: readonly CategoryDraft[],
  at: { category: string | null; entry: string | null } | null,
): DraftFault | null {
  if (!at || at.category === null) return null;
  const d = drafts.find((x) => x.name.trim() === at.category);
  if (!d) return null;
  if (at.entry === null) return { key: d.key, field: 'name', entry: null };
  const entry = at.entry;
  if (d.refs.some((r) => `${r.set}:${r.tag.toLowerCase()}` === entry.toLowerCase())) return { key: d.key, field: 'ref', entry };
  // Сервер режет длинную запись до 40 знаков и добавляет «...».
  const hit = (list: string[]) => list.some((e) => e === entry || (entry.endsWith('...') && e.startsWith(entry.slice(0, -3))));
  if (hit(parseEntries(d.manualText))) return { key: d.key, field: 'manual', entry };
  if (hit(parseEntries(d.excludeText))) return { key: d.key, field: 'exclude', entry };
  return { key: d.key, field: null, entry };
}

/** Подпись источника: сколько категорий и из скольких наборов они берутся. */
export function compositeStats(categories: readonly GeoCompositeCategory[]): { categories: number; sets: number } {
  return { categories: categories.length, sets: new Set(categories.flatMap((c) => c.refs.map((r) => r.set))).size };
}
