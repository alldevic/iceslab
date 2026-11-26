import { describe, expect, it } from 'vitest';
import { frontendFilterPaths, matchesFilter, outsideFrontendFilter } from './backendSource';

describe('the frontend path filter of ci.yml, as the mirrors read it', () => {
  it('parses to the common set, the app, shared and the backend files the mirrors read', () => {
    const paths = frontendFilterPaths();
    expect(paths).toContain('pnpm-lock.yaml');
    expect(paths).toContain('apps/panel-frontend/**');
    expect(paths).toContain('apps/panel-backend/src/modules/**/*.mapper.ts');
  });

  it('matches by the filter\'s own glob rules', () => {
    const g = ['apps/x/**', 'a/**/*.mapper.ts', 'a/b.ts'];
    expect(matchesFilter('apps/x/y/z.ts', g)).toBe(true);
    expect(matchesFilter('a/m/n.mapper.ts', g)).toBe(true);
    expect(matchesFilter('a/n.mapper.ts', g)).toBe(true);
    expect(matchesFilter('a/b.ts', g)).toBe(true);
    expect(matchesFilter('a/bxts', g)).toBe(false);
    expect(matchesFilter('a/m/n.service.ts', g)).toBe(false);
  });

  it('a mapper and a schema file start the job, other backend files do not', () => {
    expect(outsideFrontendFilter(['users/users.mapper.ts', 'nodes/nodes.schemas.ts'])).toEqual([]);
    expect(outsideFrontendFilter(['nodes/nodes.service.ts', 'users/users.routes.ts'])).toEqual([
      'nodes/nodes.service.ts',
      'users/users.routes.ts',
    ]);
  });
});
