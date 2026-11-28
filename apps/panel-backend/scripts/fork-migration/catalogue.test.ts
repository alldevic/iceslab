import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ANALOGS, OLD_COMMIT, OLD_ONLY_MIGRATIONS, migrationsToApply, oldMigrationNames, omegaMigrationNames } from './catalogue.js';

describe('the two migration chains (20.3)', () => {
  const old = oldMigrationNames();
  const omega = omegaMigrationNames();

  it('the old fork has 65 migrations, no repeats', () => {
    expect(old).toHaveLength(65);
    expect(new Set(old).size).toBe(65);
  });

  it('old-migrations.txt is what 040410ac holds (checked where the commit is in the clone)', () => {
    let listed: string[] | null = null;
    try {
      listed = execFileSync('git', ['ls-tree', '--name-only', '--full-tree', OLD_COMMIT, 'apps/panel-backend/prisma/migrations/'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map((l) => l.replace(/^.*\//, ''))
        .filter((l) => l && l !== 'migration_lock.toml')
        .sort();
    } catch {
      /* a clone without the old fork's history: the list stays as frozen */
    }
    if (listed) expect(listed).toEqual([...old].sort());
  });

  it('50 migrations are common, 15 are the old fork only, 61 the new one only', () => {
    const o = new Set(old);
    const w = new Set(omega);
    expect(old.filter((n) => w.has(n))).toHaveLength(50);
    expect(old.filter((n) => !w.has(n))).toHaveLength(15);
    expect(omega.filter((n) => !o.has(n))).toHaveLength(61);
  });

  it('the seven analogs exist in this repository and replace old migrations only', () => {
    expect(Object.keys(ANALOGS)).toHaveLength(7);
    for (const [name, replaced] of Object.entries(ANALOGS)) {
      expect(omega, name).toContain(name);
      for (const r of replaced) expect(old, r).toContain(r);
    }
  });

  it('the 15 removed journal names are exactly the old-only ones', () => {
    const w = new Set(omega);
    expect([...OLD_ONLY_MIGRATIONS].sort()).toEqual(old.filter((n) => !w.has(n)).sort());
  });

  it('48 migrations of the base and 6 of the new fork are left to run', () => {
    const run = migrationsToApply();
    expect(run).toHaveLength(54);
    expect(run.filter((n) => n >= '20261126')).toHaveLength(6);
    expect(run.filter((n) => n < '20261126')).toHaveLength(48);
  });
});
