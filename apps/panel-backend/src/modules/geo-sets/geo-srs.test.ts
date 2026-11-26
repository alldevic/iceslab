import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileSrs, SingboxMissingError, SrsCompileError } from './geo-srs.js';
import type { RuleSetJson } from './geo-dat.js';

/**
 * The `.srs` compiler (milestone 10.5). The real one runs when SINGBOX_BIN (or
 * an install path) names a sing-box, as in CI; the failures are shown with
 * scripts standing in for it, so they run everywhere.
 */
const RULES: RuleSetJson = { version: 2, rules: [{ domain_keyword: ['ads', 'track'], ip_cidr: ['10.0.0.0/8', '2001:db8::/32'] }] };
const BIN = [process.env.SINGBOX_BIN ?? '', '/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => p !== '' && existsSync(p)) ?? '';

const work = mkdtempSync(join(tmpdir(), 'iceslab-srs-test-'));
const script = (name: string, body: string): string => {
  const p = join(work, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('iceslab-srs-') && !n.startsWith('iceslab-srs-test-'));

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!BIN)('with a real sing-box', () => {
  it('compiles a rule-set source into a .srs the same sing-box takes back', async () => {
    const srs = await compileSrs(RULES, { bin: BIN });
    expect(srs.subarray(0, 3).toString('latin1')).toBe('SRS');
    const file = join(work, 'back.srs');
    writeFileSync(file, srs);
    execFileSync(BIN, ['rule-set', 'decompile', '-o', join(work, 'back.json'), file]);
    const back = JSON.parse(readFileSync(join(work, 'back.json'), 'utf8')) as RuleSetJson;
    expect(back.rules).toEqual(RULES.rules);
  });

  it('an empty set (a tag that filters to nothing) compiles too', async () => {
    expect((await compileSrs({ version: 2, rules: [] }, { bin: BIN })).length).toBeGreaterThan(0);
  });

  it('a source sing-box refuses is an error with its words, and nothing is left behind', async () => {
    const before = leftovers();
    await expect(compileSrs({ version: 2, rules: [{ ip_cidr: ['not-a-cidr'] }] }, { bin: BIN })).rejects.toThrow(SrsCompileError);
    expect(leftovers()).toEqual(before);
  });
});

describe('without it', () => {
  it('no binary: a plain error that says what to set', async () => {
    vi.stubEnv('SINGBOX_BIN', '/nowhere/sing-box');
    await expect(compileSrs(RULES)).rejects.toThrow(SingboxMissingError);
    await expect(compileSrs(RULES)).rejects.toThrow(/SINGBOX_BIN/);
    await expect(compileSrs(RULES, { bin: '' })).rejects.toThrow(/set SINGBOX_BIN/);
  });

  it('SINGBOX_BIN is read when it compiles', async () => {
    vi.stubEnv('SINGBOX_BIN', script('env-bin.sh', 'while [ "$1" != -o ]; do shift; done; printf SRS-env > "$2"'));
    expect((await compileSrs(RULES)).toString()).toBe('SRS-env');
  });

  it('a compiler that runs past the limit is killed, and the error says so', async () => {
    const bin = script('slow.sh', 'sleep 30');
    const before = leftovers();
    const t0 = Date.now();
    await expect(compileSrs(RULES, { bin, timeoutMs: 300 })).rejects.toThrow(/did not finish in 300 ms and was killed/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(leftovers()).toEqual(before);
  });

  it('a failing compiler: its stderr is in the error, the directory is gone', async () => {
    const bin = script('fail.sh', 'echo "bad rule" >&2; exit 3');
    const before = leftovers();
    await expect(compileSrs(RULES, { bin })).rejects.toThrow(/failed: bad rule/);
    expect(leftovers()).toEqual(before);
  });

  it('a success leaves no directory behind either', async () => {
    const bin = script('ok.sh', 'while [ "$1" != -o ]; do shift; done; printf SRS > "$2"');
    const before = leftovers();
    expect((await compileSrs(RULES, { bin })).toString()).toBe('SRS');
    expect(leftovers()).toEqual(before);
  });

  it('the source it is handed is the rule-set JSON, the output path is the one it is told', async () => {
    const bin = script('echo.sh', 'for a; do last=$a; done; while [ "$1" != -o ]; do shift; done; cat "$last" > "$2"');
    const out = await compileSrs(RULES, { bin });
    expect(JSON.parse(out.toString())).toEqual(RULES);
  });
});
