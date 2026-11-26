/**
 * The backend schema files as text, for the mirror tests that hold a form
 * constant to a number bound of the API (CONTRIBUTING.md, "Mirror tests").
 * Text, not an import: the frontend has no zod and takes no backend module.
 * `import.meta.glob` rather than `node:fs`, as contractCopies.test.ts does:
 * this app's types have no `node`.
 */
const FILES = import.meta.glob('../../../panel-backend/src/modules/{inbounds,profiles}/*.schemas.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The text of `modules/<module>/<file>` of the backend, e.g.
 *  backendSource('inbounds/inbounds.schemas.ts'). Throws if it is not there. */
export function backendSource(path: string): string {
  const hit = Object.entries(FILES).find(([k]) => k.endsWith(`/modules/${path}`));
  if (!hit) throw new Error(`backend source ${path} not found: widen the glob in test-support/backendSource.ts`);
  return hit[1];
}

/** The text of the one `export const <name> = …;` statement, or throws: a
 *  rename on the backend then fails the mirror, loudly. */
export function exportedConst(source: string, name: string): string {
  const m = source.match(new RegExp(`export const ${name}\\b[\\s\\S]*?;\\n`));
  if (!m) throw new Error(`export const ${name} not found in the backend source`);
  return m[0];
}
