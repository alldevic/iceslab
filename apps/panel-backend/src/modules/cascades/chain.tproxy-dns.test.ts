import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderChainConfig, TPROXY_IN_TAG, type ChainRenderInput } from './chain.config.js';

/**
 * E56, stand 26.09: an AmneziaWG entry answered its clients' DNS itself. The
 * query (10.66.66.3 -> 1.1.1.1:53, Amnezia DNS in the app) came in by TPROXY,
 * the chain's hijack-dns took it and the entry's system resolver answered: the
 * hoster's, in RU, for traffic that left in NL. So every CDN answer pointed at
 * a Russian edge.
 *
 * On an entry that takes TPROXY the hijack now stays on the socks listeners
 * (xray and hysteria users, unchanged), and the tunnel's DNS goes on like any
 * UDP.
 */
const SINGBOX_BIN =
  process.env.SINGBOX_BIN ??
  ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ??
  '';

const entry = (over: Partial<ChainRenderInput> = {}): ChainRenderInput => ({
  role: 'entry',
  socksPassword: 'chain-socks-fixture-password-0000',
  directionTags: [0, 1],
  out: [],
  foreign: [{ tag: 1, type: 'socks', config: { server: '192.0.2.1', port: 1080 } }],
  tproxy: { ordinal: 0 },
  ...over,
});

type Rules = { route: { rules: Record<string, unknown>[] } };

describe('hijack-dns on an entry', () => {
  it('with TPROXY: on the socks listeners only, never on the tunnel', () => {
    const cfg = renderChainConfig(entry()) as Rules;
    expect(cfg.route.rules[1]).toEqual({ protocol: 'dns', inbound: ['in-d0', 'in-d1'], action: 'hijack-dns' });
    // And no other rule takes the tunnel's DNS aside: after the protections,
    // it meets the policy and the Auto line like any UDP.
    const tunnel = cfg.route.rules.filter((r) => Array.isArray(r.inbound) && (r.inbound as string[]).includes(TPROXY_IN_TAG));
    expect(tunnel).toEqual([{ inbound: [TPROXY_IN_TAG], action: 'route', outbound: 'out-d0' }]);
  });

  it('without TPROXY (an xray or hysteria entry): everywhere, as it always was', () => {
    const cfg = renderChainConfig(entry({ tproxy: undefined })) as Rules;
    expect(cfg.route.rules[1]).toEqual({ protocol: 'dns', action: 'hijack-dns' });
  });
});

// ───── live ─────

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

async function freeTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = createTcpServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function freeUdpPort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** A one-question DNS query for `name`, A, IN. */
function query(id: number, name: string): Buffer {
  const labels = name.split('.').flatMap((l) => [Buffer.from([l.length]), Buffer.from(l)]);
  return Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
}

/**
 * The resolver the client asked (1.1.1.1 on the phone): counts the queries it
 * gets and answers each with the same id and one A record, 203.0.113.53, which
 * no real resolver gives for this name.
 */
async function fakeResolver(): Promise<{ port: number; queries: () => number; close: () => void }> {
  let n = 0;
  const s: UdpSocket = createSocket('udp4');
  s.on('message', (msg, from) => {
    n += 1;
    const answer = Buffer.concat([
      Buffer.from([msg[0]!, msg[1]!, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]),
      msg.subarray(12),
      Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 53]),
    ]);
    s.send(answer, from.port, from.address);
  });
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  return { port: s.address().port, queries: () => n, close: () => s.close() };
}

/** Ask through the entry, as the phone's tunnel does; the answer, or null. */
async function ask(port: number, id: number): Promise<Buffer | null> {
  const s = createSocket('udp4');
  try {
    return await new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);
      s.on('message', (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      s.send(query(id, 'e56.iceslab.test'), port, '127.0.0.1');
    });
  } finally {
    s.close();
  }
}

function run(name: string, config: unknown): { log: () => string; child: ChildProcess } {
  const dir = mkdtempSync(join(tmpdir(), `iceslab-e56-${name}-`));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  const child = spawn(SINGBOX_BIN, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  return { child, log: () => `--- ${name}\n${out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-15).join('\n')}` };
}

describe('the tunnel DNS goes where the traffic goes, live', () => {
  it.skipIf(!SINGBOX_BIN)(
    'a query off the tunnel reaches the resolver the client asked, through the direction; the old hijack answered it at the entry',
    async () => {
      const resolver = await fakeResolver();
      // The direction: a vless server whose only way on is `direct`, so a
      // query reaching the resolver has crossed it.
      const vlessPort = await freeTcpPort();
      const uuid = randomUUID();
      const direction = run('direction', {
        log: { level: 'warn' },
        inbounds: [{ type: 'vless', tag: 'in', listen: '127.0.0.1', listen_port: vlessPort, users: [{ uuid }] }],
        outbounds: [{ type: 'direct', tag: 'direct' }],
      });

      /**
       * The entry as the panel renders it for an AmneziaWG entry, with ONE
       * thing swapped: TPROXY needs a Linux kernel and root, so the listener
       * that stands for it is a `direct` inbound under the same tag, handing
       * the chain a UDP packet already addressed to the resolver, which is
       * what TPROXY does. Every rule is the rendered one.
       */
      const tunnelPort = await freeUdpPort();
      const render = (hijackEverywhere: boolean) => {
        const cfg = renderChainConfig(
          entry({
            foreign: [
              { tag: 1, type: 'vless', config: { server: '127.0.0.1', port: vlessPort, uuid, flow: null, security: 'none' } },
            ],
          }),
        ) as { inbounds: Record<string, unknown>[]; route: { rules: Record<string, unknown>[] } };
        cfg.inbounds = cfg.inbounds.map((i) =>
          i.tag === TPROXY_IN_TAG
            ? {
                type: 'direct',
                tag: TPROXY_IN_TAG,
                listen: '127.0.0.1',
                listen_port: tunnelPort,
                network: 'udp',
                override_address: '127.0.0.1',
                override_port: resolver.port,
              }
            : { ...i, listen_port: 0 },
        );
        // The rule as it was before E56, for the contrast.
        if (hijackEverywhere) cfg.route.rules[1] = { protocol: 'dns', action: 'hijack-dns' };
        return cfg;
      };

      const logs = [direction];
      try {
        const before = run('entry-before', render(true));
        logs.push(before);
        // Give the engine time to listen; a query that finds nothing is lost
        // either way, so the "before" case is asked twice.
        await new Promise((r) => setTimeout(r, 1500));
        await ask(tunnelPort, 0x0e56);
        const beforeAnswer = await ask(tunnelPort, 0x0e57);
        const beforeQueries = resolver.queries();
        before.child.kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 800));

        const after = run('entry-after', render(false));
        logs.push(after);
        let afterAnswer: Buffer | null = null;
        for (let i = 0; i < 10 && !afterAnswer; i++) {
          await new Promise((r) => setTimeout(r, 500));
          afterAnswer = await ask(tunnelPort, 0x0e60 + i);
        }
        const afterQueries = resolver.queries() - beforeQueries;

        // Before: answered, if at all, by the ENTRY's resolver; the resolver
        // the client asked never saw it.
        expect(beforeQueries).toBe(0);
        // After: the resolver the client asked answered, through the direction.
        expect(afterQueries).toBeGreaterThan(0);
        expect(afterAnswer).not.toBeNull();
        expect([...afterAnswer!.subarray(-4)]).toEqual([203, 0, 113, 53]);
        console.log(
          `E56 live: hijack on the tunnel (before): resolver asked ${beforeQueries}, answer ${beforeAnswer ? 'from the entry' : 'none'}; ` +
            `without it (after): resolver asked ${afterQueries}, answer ${[...afterAnswer!.subarray(-4)].join('.')} through the direction`,
        );
      } catch (err) {
        throw new Error(`${(err as Error).message}\n${logs.map((l) => l.log()).join('\n')}`);
      } finally {
        for (const c of children.splice(0)) c.kill('SIGKILL');
        resolver.close();
      }
    },
    60000,
  );
});
