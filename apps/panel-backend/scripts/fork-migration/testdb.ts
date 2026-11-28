import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, ident, withClient, withDatabase } from './pgutil.js';
import { HERE } from './catalogue.js';

/**
 * Test support: old-fork databases on the test Postgres, built from the frozen
 * baseline (fixtures/old-fork-baseline.sql: the schema, seeds and journal of a
 * fresh install of 040410ac) and, for the second, the synthetic rows of
 * fixtures/old-fork-data.sql. Each case works on its own copy (TEMPLATE), and
 * everything is dropped at the end.
 */
export interface OldForkDbs {
  adminUrl: string;
  /** Make a database from the empty (old schema, seeds) or the filled template. */
  copy(from: 'empty' | 'filled'): Promise<{ name: string; url: string }>;
  drop(name: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function oldForkDbs(databaseUrl: string): Promise<OldForkDbs> {
  const adminUrl = withDatabase(databaseUrl, 'postgres');
  const tag = `forkmig_${randomBytes(4).toString('hex')}`;
  const created: string[] = [];
  const make = async (name: string, template?: string): Promise<void> => {
    await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${ident(name)}${template ? ` TEMPLATE ${ident(template)}` : ''}`));
    created.push(name);
  };

  const empty = `${tag}_empty`;
  await make(empty);
  const c = await connect(withDatabase(databaseUrl, empty));
  try {
    await c.query(readFileSync(join(HERE, 'fixtures', 'old-fork-baseline.sql'), 'utf8'));
    await c.query(`SET search_path TO public`);
  } finally {
    await c.end();
  }
  const filled = `${tag}_filled`;
  await make(filled, empty);
  const f = await connect(withDatabase(databaseUrl, filled));
  try {
    await f.query(readFileSync(join(HERE, 'fixtures', 'old-fork-data.sql'), 'utf8'));
  } finally {
    await f.end();
  }

  let n = 0;
  const drop = async (name: string): Promise<void> => {
    await withClient(adminUrl, (a) => a.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
  };
  return {
    adminUrl,
    async copy(from) {
      const name = `${tag}_c${++n}`;
      await make(name, from === 'empty' ? empty : filled);
      return { name, url: withDatabase(databaseUrl, name) };
    },
    drop,
    async cleanup() {
      // The _migrating copies and renamed databases of a move are named after their source.
      const left = await withClient(adminUrl, async (a) => (await a.query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [`${tag}%`])).rows as Array<{ datname: string }>);
      for (const d of left) await drop(d.datname);
      void created;
    },
  };
}
