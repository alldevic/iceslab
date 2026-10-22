import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEntryUserGate } from './cascade.config.js';
import { routeTag } from './cascade.config.js';

/**
 * A-134, live (lesson E51: a routing rule is proven by counters, not by
 * "check passed"). A real xray entry carries the rules applyEntryUserGate
 * draws; clients pick a tag in their UUID (the third group, which auth
 * ignores and routing reads) and each way out is a counting proxy.
 *
 *   - u-nl may take direction 1 only: tag 1 reaches proxy A, and rewriting the
 *     UUID to tag 2 lands in the trap (the attack A-134 is about);
 *   - u-all may take both: tag 2 reaches proxy B;
 *   - u-new is a client of the entry the gate has not seen: trapped on a
 *     gated tag, let through on a tag every known user may take (no list
 *     is drawn for those; the user's own push closes that window).
 *
 * Skipped without XRAY_BIN, like the other engine tests.
 */
const XRAY = process.env.XRAY_BIN ?? '';
const P = { entry: 31201, target: 31210, a: 31211, b: 31212, client: 31220 };
const users = {
  'u-nl': '11111111-2222-0000-4444-000000000001',
  'u-all': '11111111-2222-0000-4444-000000000002',
  'u-new': '11111111-2222-0000-4444-000000000003',
} as const;
const withTag = (id: string, tag: number) => {
  const g = id.split('-');
  g[2] = tag.toString(16).padStart(4, '0');
  return g.join('-');
};

const counts = { a: 0, b: 0 };
const servers: Server[] = [];
const procs: ChildProcess[] = [];

function countingProxy(name: 'a' | 'b', port: number): void {
  const s = createServer();
  s.on('connect', (req, sock, head) => {
    counts[name]++;
    const [h, p] = (req.url ?? '').split(':');
    const up = net.connect(Number(p), h, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  s.listen(port, '127.0.0.1');
  servers.push(s);
}

function socksGet(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let stage = 0;
    let body = '';
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(4000, () => done(false));
    s.on('data', (d) => {
      if (stage === 0) {
        s.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, P.target >> 8, P.target & 255]));
        stage = 1;
        return;
      }
      if (stage === 1) {
        if (d[1] !== 0) return done(false);
        stage = 2;
        s.write('GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n');
        return;
      }
      body += d.toString();
      if (body.includes('pong')) done(true);
    });
    s.on('error', () => done(false));
    s.on('close', () => resolve(body.includes('pong')));
    s.write(Buffer.from([5, 1, 0]));
  });
}

let dir = '';
let clientSeq = 0;
async function clientFor(id: string, tag: number): Promise<number> {
  const port = P.client + clientSeq++;
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { udp: false } }],
    outbounds: [
      {
        protocol: 'vless',
        settings: { vnext: [{ address: '127.0.0.1', port: P.entry, users: [{ id: withTag(id, tag), encryption: 'none' }] }] },
        streamSettings: { network: 'tcp' },
      },
    ],
  };
  const f = join(dir, `client-${port}.json`);
  writeFileSync(f, JSON.stringify(cfg));
  procs.push(spawn(XRAY, ['run', '-c', f], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 700));
  return port;
}

describe.skipIf(!XRAY)('an xray entry with the A-134 gate, counted', () => {
  const d1 = routeTag(0, 0);
  const d2 = routeTag(0, 1);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'entry-gate-'));
    servers.push(createServer((_q, r) => r.end('pong')).listen(P.target, '127.0.0.1'));
    countingProxy('a', P.a);
    countingProxy('b', P.b);
    const rules = applyEntryUserGate(
      [
        { type: 'field', vlessRoute: String(d1), outboundTag: 'out-a' },
        { type: 'field', vlessRoute: String(d2), outboundTag: 'out-b' },
      ],
      new Map([
        ['u-nl', new Set([d1])],
        ['u-all', new Set([d1, d2])],
      ]),
    );
    const entry = {
      log: { loglevel: 'warning' },
      inbounds: [
        {
          tag: 'in-vless',
          listen: '127.0.0.1',
          port: P.entry,
          protocol: 'vless',
          settings: { decryption: 'none', clients: Object.entries(users).map(([email, id]) => ({ id, email })) },
          streamSettings: { network: 'tcp' },
        },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'blocked', protocol: 'blackhole' },
        { tag: 'out-a', protocol: 'http', settings: { servers: [{ address: '127.0.0.1', port: P.a }] } },
        { tag: 'out-b', protocol: 'http', settings: { servers: [{ address: '127.0.0.1', port: P.b }] } },
      ],
      routing: { domainStrategy: 'AsIs', rules },
    };
    const f = join(dir, 'entry.json');
    writeFileSync(f, JSON.stringify(entry));
    procs.push(spawn(XRAY, ['run', '-c', f], { stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 1000));
  }, 30_000);

  afterAll(() => {
    for (const p of procs) p.kill();
    for (const s of servers) s.close();
  });

  it('lets each user through the tags they were handed, and traps the rest', async () => {
    const before = { ...counts };
    expect(await socksGet(await clientFor(users['u-nl'], d1))).toBe(true);
    expect(counts.a - before.a).toBe(1);

    // The attack: same user, UUID rewritten to the other direction's tag.
    expect(await socksGet(await clientFor(users['u-nl'], d2))).toBe(false);
    expect(counts.b - before.b).toBe(0);

    expect(await socksGet(await clientFor(users['u-all'], d2))).toBe(true);
    expect(counts.b - before.b).toBe(1);

    // A client the gate has not seen yet, on a GATED tag: closed by default.
    expect(await socksGet(await clientFor(users['u-new'], d2))).toBe(false);
    expect(counts.b - before.b).toBe(1);
    // On a tag every known user may take there is no list, so it passes: the
    // window until the push that names this user (addUser queues it).
    expect(await socksGet(await clientFor(users['u-new'], d1))).toBe(true);
    expect(counts.a - before.a).toBe(2);
  }, 30_000);
});
