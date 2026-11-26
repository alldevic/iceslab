import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { singboxAvailable, singboxBinary } from '../../lib/util/singbox-bin.js';
import type { RuleSetJson } from './geo-dat.js';

/**
 * A sing-box rule-set source as the `.srs` a client loads (milestone 10.5):
 * `sing-box rule-set compile` run on the panel, in a directory of its own that
 * is removed afterwards, with a time limit and a kill at the limit. The input is
 * what geositeRuleSet / geoipRuleSet already build from a set's category.
 */
export const SRS_COMPILE_TIMEOUT_MS = 60_000;

/** No sing-box on the panel: the caller serves no `.srs`, it does not retry. */
export class SingboxMissingError extends Error {
  constructor(bin: string) {
    super(
      bin === ''
        ? 'no sing-box executable on the panel: set SINGBOX_BIN (the panel image does) to compile .srs rule-sets'
        : `SINGBOX_BIN points at ${bin}, which is not there: .srs rule-sets cannot be compiled`,
    );
    this.name = 'SingboxMissingError';
  }
}

export class SrsCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SrsCompileError';
  }
}

export interface CompileOpts {
  bin?: string;
  timeoutMs?: number;
}

export async function compileSrs(rules: RuleSetJson, opts: CompileOpts = {}): Promise<Buffer> {
  const bin = opts.bin ?? singboxBinary();
  if (!singboxAvailable(bin)) throw new SingboxMissingError(bin);
  const timeout = opts.timeoutMs ?? SRS_COMPILE_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpdir(), 'iceslab-srs-'));
  try {
    const src = join(dir, 'rules.json');
    const out = join(dir, 'rules.srs');
    await writeFile(src, JSON.stringify(rules));
    await new Promise<void>((resolve, reject) => {
      // killSignal SIGKILL: at the limit the process is gone, not asked to leave.
      execFile(bin, ['rule-set', 'compile', '-o', out, src], { timeout, killSignal: 'SIGKILL', cwd: dir }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        if ((err as { killed?: boolean }).killed) return reject(new SrsCompileError(`sing-box rule-set compile did not finish in ${timeout} ms and was killed`));
        reject(new SrsCompileError(`sing-box rule-set compile failed: ${String(stderr).trim() || err.message}`));
      });
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
