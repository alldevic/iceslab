/**
 * Whether two stored values are the same value: scalars, dates, arrays and
 * JSON objects, the last compared by content whatever their key order (a JSON
 * column read back from Postgres does not keep the order it was written in).
 * null and undefined are one "nothing". For "did this save change anything"
 * questions (A-122), where a false "yes" raises an alarm and a false "no"
 * hides one.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  return JSON.stringify(normalise(v)) ?? 'null';
}

function normalise(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, normalise(o[k])]),
    );
  }
  return v;
}

/** Whether any of `keys` that `next` carries differs from `prev`. A key
 *  absent from `next` is no edit. */
export function anyChanged<T extends object>(prev: T, next: Partial<T>, keys: readonly (keyof T)[]): boolean {
  return keys.some((k) => k in next && next[k] !== undefined && !sameValue(prev[k], next[k]));
}
