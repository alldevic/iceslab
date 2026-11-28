import pg from 'pg';

export type Client = pg.Client;

export function parseUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a postgres:// URL');
  }
  return u;
}

export function databaseName(url: string): string {
  return decodeURIComponent(parseUrl(url).pathname.replace(/^\//, ''));
}

/** The same server and credentials, another database. */
export function withDatabase(url: string, db: string): string {
  const u = parseUrl(url);
  u.pathname = '/' + encodeURIComponent(db);
  return u.toString();
}

export async function connect(url: string): Promise<Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

export async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect(url);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A double-quoted identifier. Only ever fed names this script builds or reads
 *  from the catalogue, but quoted anyway. */
export function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export async function one<T = Record<string, unknown>>(c: Client, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await c.query(sql, params);
  return r.rows[0] as T | undefined;
}

export async function rows<T = Record<string, unknown>>(c: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}

export async function tableExists(c: Client, name: string): Promise<boolean> {
  return !!(await one(c, `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name]));
}

export async function columnExists(c: Client, table: string, column: string): Promise<boolean> {
  return !!(await one(
    c,
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  ));
}
