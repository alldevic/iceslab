import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { prisma } from '../../prisma.js';
import { closeRedis } from '../../lib/infra/redis.js';
import { cleanDatabase } from '../../../tests/helpers/db.js';
import { HotswapController } from './pool.hotswap.js';
import { DEFAULT_HOTSWAP_CONFIG, type SwapNotice } from './pool.types.js';
import {
  PROVISION_TIMEOUT_MS,
  createAnsibleRunner,
  makeHotswapDeps,
  type AnsibleRunnerSettings,
  type ProvisionVars,
} from './pool.service.js';

// The runner that runs the role from the panel, with `execFile` replaced.

type Exec = Parameters<typeof createAnsibleRunner>[0] & {};

const TOKEN = 'bs_0123456789abcdef0123456789abcdef0123456789abcdef';
const vars: ProvisionVars = {
  iceslab_panel_url: 'https://panel.example.com',
  iceslab_bootstrap_token: TOKEN,
  iceslab_engines: ['xray', 'singbox'],
};
const spare = { id: 'n1', name: 'spare-01' };
const settings = (over: Partial<AnsibleRunnerSettings> = {}) => (): AnsibleRunnerSettings => ({
  playbook: '/opt/iceslab/deploy/ansible/site.yml',
  inventory: '',
  bin: 'ansible-playbook',
  ...over,
});

/** What the process was started with and what its vars file looked like at that moment. */
function spyExec(result: { stdout?: string } | Error = { stdout: 'PLAY RECAP\nspare-01 : ok=9 changed=3\n' }) {
  const seen: {
    file: string;
    args: string[];
    opts: Parameters<Exec>[2];
    varsFile?: string;
    varsMode?: number;
    varsBody?: Record<string, unknown>;
    dirMode?: number;
  }[] = [];
  const exec: Exec = vi.fn(async (file, args, opts) => {
    const i = args.indexOf('-e');
    const varsFile = i >= 0 ? args[i + 1]!.replace(/^@/, '') : undefined;
    seen.push({
      file,
      args,
      opts,
      varsFile,
      ...(varsFile && existsSync(varsFile)
        ? {
            varsMode: statSync(varsFile).mode & 0o777,
            varsBody: JSON.parse(readFileSync(varsFile, 'utf8')) as Record<string, unknown>,
            dirMode: statSync(dirname(varsFile)).mode & 0o777,
          }
        : {}),
    });
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '' };
  });
  return { exec, seen };
}

let out: string[] = [];
beforeEach(async () => {
  vi.restoreAllMocks();
  out = [];
  // No base logger is set in tests: getLogger() is the console shim.
  for (const m of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
  }
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await prisma.$disconnect();
  await closeRedis();
});

describe('the ansible runner', () => {
  it('without a playbook starts no process and logs once, without the token', async () => {
    const { exec, seen } = spyExec();
    await createAnsibleRunner(exec, settings({ playbook: '' })).provision(spare, vars);
    expect(seen).toHaveLength(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('spare-01');
    expect(out.join('\n')).not.toContain(TOKEN);
    expect(out.join('\n')).not.toContain(TOKEN.slice(0, 8));
  });

  it('with a playbook runs it limited to the spare, the token only in a 0600 file that is gone afterwards', async () => {
    const { exec, seen } = spyExec();
    await createAnsibleRunner(exec, settings({ inventory: '/run/pool/inventory.ini', bin: '/usr/bin/ansible-playbook' })).provision(
      spare,
      vars,
    );
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.file).toBe('/usr/bin/ansible-playbook');
    expect(s.args).toEqual([
      '/opt/iceslab/deploy/ansible/site.yml',
      '-i',
      '/run/pool/inventory.ini',
      '--limit',
      'spare-01',
      '-e',
      `@${s.varsFile}`,
    ]);
    expect(s.args.join(' ')).not.toContain(TOKEN);
    expect(s.args.join(' ')).not.toContain(TOKEN.slice(0, 8));
    expect(s.varsMode).toBe(0o600);
    expect(s.dirMode).toBe(0o700);
    expect(s.varsBody).toEqual({
      iceslab_panel_url: 'https://panel.example.com',
      iceslab_bootstrap_token: TOKEN,
      iceslab_engines: ['xray', 'singbox'],
    });
    expect(s.opts.timeout).toBe(PROVISION_TIMEOUT_MS);
    expect(s.opts.cwd).toBe('/opt/iceslab/deploy/ansible');
    expect(s.opts.env.ANSIBLE_HOST_KEY_CHECKING).toBe('False');
    expect(existsSync(s.varsFile!)).toBe(false);
    expect(existsSync(dirname(s.varsFile!))).toBe(false);
  });

  it('leaves the inventory out when none is set, and the engines out when there are none (the inventory\'s stay)', async () => {
    const { exec, seen } = spyExec();
    await createAnsibleRunner(exec, settings()).provision(spare, { ...vars, iceslab_engines: [] });
    expect(seen[0]!.args).not.toContain('-i');
    expect(seen[0]!.varsBody).not.toHaveProperty('iceslab_engines');
  });

  it('refuses a node name that is an ansible pattern, starting nothing', async () => {
    const { exec, seen } = spyExec();
    const runner = createAnsibleRunner(exec, settings());
    for (const name of ['all', 'web*', 'a:b', '!x', 'node 1', 'узел', '-x']) {
      await expect(runner.provision({ id: 'n', name }, vars)).rejects.toThrow(/cannot be an ansible host name/);
    }
    expect(seen).toHaveLength(0);
  });

  it('a failed run throws, removes the file, and keeps the token out of the error', async () => {
    const err = Object.assign(new Error(`Command failed: ansible-playbook x\nfatal: token ${TOKEN} rejected`), {
      stderr: `UNREACHABLE! ssh: connect to host 10.0.0.9 port 22: Connection refused\nbs token was ${TOKEN}`,
    });
    const { exec, seen } = spyExec(err);
    const p = createAnsibleRunner(exec, settings()).provision(spare, vars);
    await expect(p).rejects.toThrow(/ansible-playbook failed on spare-01/);
    const e = (await p.catch((x: unknown) => x)) as Error;
    expect(e.message).toContain('Connection refused');
    expect(e.message).not.toContain(TOKEN);
    expect(existsSync(dirname(seen[0]!.varsFile!))).toBe(false);
  });

  it('a run that timed out is named as such', async () => {
    const { exec } = spyExec(Object.assign(new Error('Command failed: x'), { killed: true, signal: 'SIGTERM' }));
    await expect(createAnsibleRunner(exec, settings()).provision(spare, vars)).rejects.toThrow(/timed out after 600s/);
  });
});

describe('a swap with the real runner', () => {
  async function pair() {
    const burned = await prisma.node.create({
      data: { name: 'burned', address: 'burned.test', status: 'online', heartbeatSecret: Buffer.alloc(32), hardening: { pool: { asn: 'AS1' } } },
    });
    const sp = await prisma.node.create({
      data: {
        name: 'spare-01',
        address: 'spare.test',
        status: 'disabled',
        heartbeatSecret: Buffer.alloc(32),
        intendedEngines: ['xray'],
        hardening: { pool: { spare: true, asn: 'AS2' } },
      },
    });
    return { burned, sp };
  }
  async function swap(burnedId: string, exec: Exec, cfg: Partial<AnsibleRunnerSettings>) {
    let scheduled: (() => void) | undefined;
    const notices: SwapNotice[] = [];
    const c = new HotswapController(
      { ...DEFAULT_HOTSWAP_CONFIG, enabled: true },
      makeHotswapDeps({
        runner: createAnsibleRunner(exec, settings(cfg)),
        notify: (n) => notices.push(n),
        schedule: (fn) => void (scheduled = fn),
      }),
    );
    c.onAnomaly({ nodeId: burnedId, severity: 'critical', bytesThisPoll: 0, expectedBaseline: 1, activeUsers: 0, droppedUsers: 30 });
    scheduled!();
    await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10_000 });
    return notices;
  }
  const status = async (id: string) => (await prisma.node.findUniqueOrThrow({ where: { id } })).status;

  it('without a playbook the swap still reaches retire; no log line holds the issued token', async () => {
    const { burned, sp } = await pair();
    const { exec, seen } = spyExec();
    const notices = await swap(burned.id, exec, { playbook: '' });
    expect(notices[0]).toMatchObject({ kind: 'swapped' });
    expect(seen).toHaveLength(0);
    expect(await status(sp.id)).toBe('unknown');
    expect(await status(burned.id)).toBe('disabled');
    const issued = await prisma.nodeBootstrapToken.findMany({ where: { nodeId: sp.id } });
    expect(issued).toHaveLength(1);
    const logs = out.join('\n');
    expect(logs).toContain('spare-01');
    expect(logs).not.toContain(issued[0]!.token);
    expect(logs).not.toContain(issued[0]!.token.slice(0, 8));
  });

  it('with a playbook the run gets the issued token by file, and no log line or notice holds it', async () => {
    const { burned, sp } = await pair();
    const { exec, seen } = spyExec();
    const notices = await swap(burned.id, exec, {});
    expect(notices[0]).toMatchObject({ kind: 'swapped' });
    const issued = await prisma.nodeBootstrapToken.findFirstOrThrow({ where: { nodeId: sp.id } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.varsBody).toMatchObject({ iceslab_bootstrap_token: issued.token, iceslab_panel_url: expect.any(String) });
    expect(seen[0]!.args).toContain('spare-01');
    const logs = out.join('\n') + JSON.stringify(notices);
    expect(logs).toContain('ansible-playbook');
    expect(logs).not.toContain(issued.token);
    expect(logs).not.toContain(issued.token.slice(0, 8));
  });

  it('an ansible failure aborts the promote: the spare stays disabled and marked, the burned node in service, the error free of the token', async () => {
    const { burned, sp } = await pair();
    const { exec } = spyExec(Object.assign(new Error('Command failed'), { stderr: 'UNREACHABLE! Connection refused' }));
    const notices = await swap(burned.id, exec, {});
    expect(notices[0]).toMatchObject({ kind: 'failed', stage: 'promote', spareId: sp.id });
    expect(await status(sp.id)).toBe('disabled');
    expect((await prisma.node.findUniqueOrThrow({ where: { id: sp.id } })).hardening).toMatchObject({ pool: { spare: true } });
    expect(await status(burned.id)).toBe('online');
    const issued = await prisma.nodeBootstrapToken.findFirstOrThrow({ where: { nodeId: sp.id } });
    expect(JSON.stringify(notices) + out.join('\n')).not.toContain(issued.token);
  });

  it('an ansible timeout aborts the promote the same way', async () => {
    const { burned, sp } = await pair();
    const { exec } = spyExec(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }));
    const notices = await swap(burned.id, exec, {});
    expect(notices[0]).toMatchObject({ kind: 'failed', stage: 'promote', error: expect.stringContaining('timed out') });
    expect(await status(sp.id)).toBe('disabled');
    expect(await status(burned.id)).toBe('online');
  });
});
