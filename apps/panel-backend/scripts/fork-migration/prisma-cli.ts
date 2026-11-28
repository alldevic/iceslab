import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataFile, panelRoot } from './catalogue.js';

/**
 * The prisma CLI of the image the script runs from, on one database. The same
 * entry the panel's own `migrate` service uses (package.json: db:migrate), so
 * the migrations run exactly as a deploy would run them.
 */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function prismaBin(): string {
  const bin = join(panelRoot(), 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(bin)) throw new Error(`prisma CLI not found at ${bin}`);
  return bin;
}

export function runPrisma(args: string[], databaseUrl: string): Promise<CliResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [prismaBin(), ...args], {
      cwd: panelRoot(),
      env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ code: code ?? 1, stdout, stderr }));
  });
}

/** The statements of a `migrate diff --script` output, comments and the CLI's
 *  own banner lines out, one normalised string each, sorted: comparable. */
export function diffStatements(stdout: string): string[] {
  const text = stdout
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('◇') && !l.startsWith('Loaded Prisma') && !l.trim().startsWith('--'))
    .join('\n');
  return text
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort()
    .map((s) => s + ';');
}

/** What the database differs from `schema` (a path, or the omega `prisma` dir) by. */
export async function schemaDiff(databaseUrl: string, schema: string): Promise<{ equal: boolean; statements: string[]; stderr: string; code: number }> {
  const r = await runPrisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', schema, '--script', '--exit-code'], databaseUrl);
  if (r.code !== 0 && r.code !== 2) {
    return { equal: false, statements: [`prisma migrate diff failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 600)}`], stderr: r.stderr, code: r.code };
  }
  return { equal: r.code === 0, statements: r.code === 0 ? [] : diffStatements(r.stdout), stderr: r.stderr, code: r.code };
}

export const OLD_SCHEMA = (): string => dataFile('old-schema.prisma');
export const OMEGA_SCHEMA = (): string => join(panelRoot(), 'prisma');
