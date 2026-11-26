/**
 * The backend sources as text, for the mirror tests that hold a form
 * constant to a number bound of the API, a hand-written interface to a DTO (CONTRIBUTING.md, "Mirror tests").
 * Text, not an import: the frontend has no zod and takes no backend module.
 * `import.meta.glob` rather than `node:fs`, as contractCopies.test.ts does:
 * this app's types have no `node`.
 */
const FILES = import.meta.glob(['../../../panel-backend/src/modules/**/*.ts', '!**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every non-test source file of the backend modules, as `<module>/<file>` ->
 *  text. For the completeness scans; a mirror that reads one file uses
 *  backendSource(). */
export function backendModuleSources(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(FILES).map(([k, v]) => [k.slice(k.indexOf('/modules/') + '/modules/'.length), v]),
  );
}

const CI = import.meta.glob('../../../../.github/workflows/ci.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The path patterns of the `frontend:` filter of the `changes` job in ci.yml,
 *  with the `*common` set expanded. */
export function frontendFilterPaths(): string[] {
  const ci = Object.values(CI)[0];
  if (!ci) throw new Error('.github/workflows/ci.yml not found');
  const lines = ci.split('\n');
  const section = (name: string): string[] => {
    const at = lines.findIndex((l) => new RegExp(`^\\s+${name}:(\\s+&\\w+)?\\s*$`).test(l));
    if (at < 0) throw new Error(`filter ${name} not found in ci.yml`);
    const indent = /^\s*/.exec(lines[at]!)![0].length;
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === '' || l.trim().startsWith('#')) continue;
      if (/^\s*/.exec(l)![0].length <= indent) break;
      out.push(l.trim());
    }
    return out;
  };
  const paths: string[] = [];
  for (const item of section('frontend')) {
    if (item === '- *common') paths.push(...section('common').map((l) => l.replace(/^- '(.*)'$/, '$1')));
    else paths.push(item.replace(/^- '(.*)'$/, '$1'));
  }
  if (paths.length < 3 || paths.some((p) => p.startsWith('-') || p.startsWith('*'))) {
    throw new Error(`frontend filter did not parse: ${JSON.stringify(paths)}`);
  }
  return paths;
}

/** Whether a repo path is picked by one of the filter's globs (`**` any depth, `*` within a segment). */
export function matchesFilter(path: string, globs: string[]): boolean {
  return globs.some((g) => {
    const re = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '@DS@')
      .replace(/\*\*/g, '@D@')
      .replace(/\*/g, '[^/]*')
      .replace(/@DS@/g, '(?:.*/)?')
      .replace(/@D@/g, '.*');
    return new RegExp(`^${re}$`).test(path);
  });
}

/** The backend files (`<module>/<file>`) whose edits do not start the frontend CI job. */
export function outsideFrontendFilter(files: string[]): string[] {
  const globs = frontendFilterPaths();
  return files.filter((f) => !matchesFilter(`apps/panel-backend/src/modules/${f}`, globs));
}

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
