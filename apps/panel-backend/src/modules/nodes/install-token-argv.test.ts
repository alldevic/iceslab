import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bootstrap token must never sit in a curl/wget argv of the node
 * installer: `ps` shows it to every local user while the request runs.
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '../../../../../scripts/install-iceslab-node.sh'), 'utf8');

describe('the node installer keeps the bootstrap token out of argv', () => {
  it('no curl or wget command line mentions a token or secret variable', () => {
    const code = script.replace(/\\\n/g, ' ').split('\n').filter((l) => !/^\s*#/.test(l));
    const bad = code.filter(
      (l) => /\b(curl|wget)\b/.test(l) && /\$\{?[A-Z_]*(TOKEN|SECRET|PASSWORD|PAYLOAD)/.test(l),
    );
    expect(bad).toEqual([]);
  });

  const fn = /^redeem_bootstrap_request\(\) \{\n[\s\S]*?^\}$/m.exec(script)?.[0] ?? '';

  const run = (url: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tokargv-'));
    const fake = join(dir, 'curl');
    writeFileSync(
      fake,
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\nprintf 200\n`,
    );
    chmodSync(fake, 0o755);
    let code = 0;
    let out = '';
    try {
      out = execFileSync('bash', ['-c', `${fn}\nredeem_bootstrap_request "$1" "${dir}/out"`, '_', url], {
        env: { PATH: `${dir}:${process.env.PATH}` },
      }).toString();
    } catch (e) {
      code = (e as { status: number }).status;
    }
    const rd = (n: string) => {
      try {
        return readFileSync(join(dir, n), 'utf8');
      } catch {
        return null;
      }
    };
    return { code, out, argv: rd('argv'), stdin: rd('stdin') };
  };

  it('finds the redemption function', () => {
    expect(fn).not.toBe('');
  });

  it('hands the URL to curl on stdin only, with the flags kept', () => {
    const r = run('https://panel.example/api/internal/bootstrap/ib_SecretTok-en_9');
    expect(r.code).toBe(0);
    expect(r.out).toBe('200');
    expect(r.argv).not.toContain('SecretTok');
    expect(r.argv).not.toContain('panel.example');
    expect(r.argv).toContain('-K\n-\n');
    expect(r.argv).toContain('--proto\n=https\n--max-redirs\n0\n');
    expect(r.stdin).toBe('url = "https://panel.example/api/internal/bootstrap/ib_SecretTok-en_9"\n');
  });

  it('refuses a URL that could break the config line', () => {
    for (const u of ['https://p/"x', 'https://p/a\\b', 'https://p/a\nheader = "X: y"']) {
      const r = run(u);
      expect(r.code).not.toBe(0);
      expect(r.argv).toBeNull();
    }
  });
});
