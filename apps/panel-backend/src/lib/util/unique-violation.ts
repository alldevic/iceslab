/**
 * What a P2002 says it collided on (A-127).
 *
 * ⚠ Not `meta.target`. Through the pg driver adapter (Prisma 7) a unique
 * violation carries `meta.driverAdapterError.cause.constraint`, which names
 * the INDEX (`cascades_name_key`) or, from some drivers, the fields; `target`
 * is absent. Measured 24.10 on cascades.name: `{ index: "cascades_name_key" }`
 * and no target. Both shapes are read, so a caller asks "was it this
 * constraint" and never reads a guess as an answer.
 */
export interface UniqueViolation {
  /** The index name, when the driver gave one. */
  index: string | null;
  /** The fields, when the driver or `meta.target` gave them. */
  fields: string[];
}

export function uniqueViolationOf(err: unknown): UniqueViolation | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return null;
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const constraint = (
    meta.driverAdapterError as { cause?: { constraint?: { index?: unknown; fields?: unknown } } } | undefined
  )?.cause?.constraint;
  const fields: string[] = [];
  if (Array.isArray(constraint?.fields)) fields.push(...constraint.fields.map(String));
  const target = meta.target;
  if (Array.isArray(target)) fields.push(...target.map(String));
  let index = typeof constraint?.index === 'string' ? constraint.index : null;
  // An older engine put the constraint's name into `target` as a string.
  if (index === null && typeof target === 'string') index = target;
  return { index, fields };
}

/** Whether a P2002 is on `index` (Prisma's `<table>_<columns>_key` name) or on exactly `fields`. */
export function isUniqueViolationOn(err: unknown, index: string, fields: string[]): boolean {
  const v = uniqueViolationOf(err);
  if (!v) return false;
  if (v.index !== null) return v.index === index;
  return v.fields.length === fields.length && fields.every((f) => v.fields.includes(f));
}
