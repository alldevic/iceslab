import { existsSync } from 'node:fs';

/**
 * Where the sing-box executable the PANEL runs is (not the node cores it hands
 * out): SINGBOX_BIN, else the usual install paths, else '' (none). The dry-run
 * of a sing-box template and the compiler of `.srs` rule-sets read it the same
 * way, and both work without it. An env path is taken as given (blank counts as unset), whether or not
 * it exists, so a wrong one shows as the run failing, not as "no binary".
 */
const SINGBOX_PATHS = ['/usr/local/bin/sing-box', '/usr/bin/sing-box'];

export function findBinary(env: string | undefined, paths: string[]): string {
  return env ?? paths.find((p) => existsSync(p)) ?? '';
}

export function singboxBinary(): string {
  return findBinary(process.env.SINGBOX_BIN?.trim() || undefined, SINGBOX_PATHS);
}

/** Whether there is a sing-box to run: the path is set and the file is there. */
export function singboxAvailable(bin: string = singboxBinary()): boolean {
  return bin !== '' && existsSync(bin);
}
