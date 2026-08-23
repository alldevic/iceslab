import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Domain, CIDR } from './geo.dat.js';

const execFileAsync = promisify(execFile);

/**
 * G6 - compile a category's domains/CIDRs into a sing-box .srs rule-set by
 * shelling out to `sing-box rule-set compile`. sing-box removed geosite:/geoip:
 * in 1.12, so a remote .srs is the only portable vehicle; generating it from the
 * source mirror self-hosts what the sing-box subscription would otherwise fetch
 * from SagerNet's GitHub (unstable from RU). Requires a sing-box binary
 * (config.SINGBOX_BIN); callers skip generation when it is not configured.
 */

// v2ray Domain.type -> sing-box source rule field.
export function domainsToSingboxRule(domains: Domain[]): Record<string, string[]> {
  const suffix: string[] = [];
  const full: string[] = [];
  const keyword: string[] = [];
  const regex: string[] = [];
  for (const d of domains) {
    if (d.type === 2) suffix.push(d.value);
    else if (d.type === 3) full.push(d.value);
    else if (d.type === 0) keyword.push(d.value);
    else if (d.type === 1) regex.push(d.value);
  }
  const rule: Record<string, string[]> = {};
  if (suffix.length) rule.domain_suffix = suffix;
  if (full.length) rule.domain = full;
  if (keyword.length) rule.domain_keyword = keyword;
  if (regex.length) rule.domain_regex = regex;
  return rule;
}

export function cidrToString(c: CIDR): string {
  const ip = c.ip;
  if (ip.length === 4) return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}/${c.prefix}`;
  if (ip.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push((((ip[i]! << 8) | ip[i + 1]!) >>> 0).toString(16));
    return `${groups.join(':')}/${c.prefix}`;
  }
  return '';
}

export function cidrsToSingboxRule(cidrs: CIDR[]): Record<string, string[]> {
  const list = cidrs.map(cidrToString).filter((s) => s !== '');
  return list.length ? { ip_cidr: list } : {};
}

/** Compile domains+cidrs into .srs bytes. Domain and IP conditions go in
 *  separate rules (OR semantics: match a domain OR an IP). Throws if the binary
 *  fails or is missing. */
export async function compileSrs(
  bin: string,
  domains: Domain[],
  cidrs: CIDR[],
): Promise<Uint8Array> {
  const rules: Record<string, string[]>[] = [];
  const dr = domainsToSingboxRule(domains);
  if (Object.keys(dr).length) rules.push(dr);
  const ir = cidrsToSingboxRule(cidrs);
  if (Object.keys(ir).length) rules.push(ir);
  const source = { version: 1, rules };

  const dir = await mkdtemp(join(tmpdir(), 'geo-srs-'));
  try {
    const inPath = join(dir, 'rs.json');
    const outPath = join(dir, 'rs.srs');
    await writeFile(inPath, JSON.stringify(source));
    // Bounded: a wedged sing-box (dead mount, blocked on tty) must not hang the
    // build forever - it runs inside the registry single-flight, so one stuck
    // process would wedge every geo request until a process restart. killSignal
    // reaps it; the error propagates and the category's .srs is simply omitted.
    await execFileAsync(bin, ['rule-set', 'compile', '--output', outPath, inPath], {
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
