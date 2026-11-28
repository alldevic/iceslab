import { databaseName, ident, one, withClient, withDatabase } from './pgutil.js';

/**
 * Step 9 and the way back (--rollback): the databases change names, nothing is
 * copied. The old database is kept as <live>_pre_fork; a rollback puts it back
 * and keeps the migrated one as <live>_migrated_<stamp>, so a second --run
 * starts from a clean copy again.
 */

export const PRE_FORK_SUFFIX = '_pre_fork';

async function exists(adminUrl: string, name: string): Promise<boolean> {
  return withClient(adminUrl, async (c) => !!(await one(c, `SELECT 1 FROM pg_database WHERE datname = $1`, [name])));
}

export async function swapIn(databaseUrl: string, migrating?: string): Promise<{ live: string; pre: string }> {
  const live = databaseName(databaseUrl);
  const next = migrating ?? `${live}_migrating`;
  const pre = `${live}${PRE_FORK_SUFFIX}`;
  const admin = withDatabase(databaseUrl, 'postgres');
  if (!(await exists(admin, next))) throw new Error(`there is no migrated copy ${next}; run --run first`);
  if (await exists(admin, pre)) throw new Error(`${pre} already exists: a previous move was not rolled back or cleaned up. Drop or rename it by hand if it is not needed.`);
  await withClient(admin, async (c) => {
    await c.query(`ALTER DATABASE ${ident(live)} RENAME TO ${ident(pre)}`);
    try {
      await c.query(`ALTER DATABASE ${ident(next)} RENAME TO ${ident(live)}`);
    } catch (err) {
      await c.query(`ALTER DATABASE ${ident(pre)} RENAME TO ${ident(live)}`);
      throw new Error(`swap failed and was undone: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  });
  return { live, pre };
}

export async function swapBack(databaseUrl: string): Promise<{ live: string; kept: string }> {
  const live = databaseName(databaseUrl);
  const pre = `${live}${PRE_FORK_SUFFIX}`;
  const admin = withDatabase(databaseUrl, 'postgres');
  if (!(await exists(admin, pre))) throw new Error(`there is no ${pre}: nothing to roll back to`);
  const kept = `${live}_migrated_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  await withClient(admin, async (c) => {
    await c.query(`ALTER DATABASE ${ident(live)} RENAME TO ${ident(kept)}`);
    try {
      await c.query(`ALTER DATABASE ${ident(pre)} RENAME TO ${ident(live)}`);
    } catch (err) {
      await c.query(`ALTER DATABASE ${ident(kept)} RENAME TO ${ident(live)}`);
      throw new Error(`rollback failed and was undone: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  });
  return { live, kept };
}
