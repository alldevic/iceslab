import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LINK_CELLS, type LinkCell } from '@iceslab/shared';
import { renderChainConfig, type ChainRenderInput } from './chain.config.js';
import { chainPoliciesOf } from './chain-policy.js';
import { CHAIN_SOCKS_USER } from './chain.ports.js';
import {
  buildCascadeConfigs,
  generateTopologyLinks,
  newLinkCred,
  topologyLinkKey,
  type LinkCred,
} from './cascade.config.js';

/**
 * Every leg cell, carrying a real request between two real sing-box processes.
 *
 * ⚠ `sing-box check` on both ends is not a leg test, and E23 is the proof: a
 * vless leg whose REALITY target sent a certificate record over the engine's
 * 8192-byte limit loaded on both nodes, passed `check` on both, and refused
 * every handshake on the stand. Nothing short of a packet going through finds
 * that class, so this file sends one per cell:
 *
 *   curl-like client -> socks of the ENTRY -> leg -> EXIT -> local HTTP server
 *
 * Both configs are the panel's own render of freshly minted credentials, the
 * same call a save makes. Only the ports are moved to free ones, so a run does
 * not depend on 24000 or 26001 being idle on the machine.
 *
 * The vless cell dials its camouflage target FOR REAL (the listener relays the
 * handshake to it), so it needs the internet; that is the point, a target is
 * only known to work by asking it. The other cells stay on loopback.
 *
 * Skips without SINGBOX_BIN like the other engine tests. CI installs the binary.
 */
const SINGBOX_BIN =
  process.env.SINGBOX_BIN ??
  ['/usr/local/bin/sing-box', '/usr/bin/sing-box'].find((p) => existsSync(p)) ??
  '';

const XRAY_BIN = process.env.XRAY_BIN ?? ['/usr/local/bin/xray'].find((p) => existsSync(p)) ?? '';

const children: ChildProcess[] = [];

/** Like run, for xray (the legacy drawing of a leg). */
function runXray(name: string, config: unknown): { log: () => string } {
  const dir = mkdtempSync(join(tmpdir(), `iceslab-live-${name}-`));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  const child = spawn(XRAY_BIN, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  return { log: () => `--- ${name}\n${out.split('\n').slice(-15).join('\n')}` };
}
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
});

/** A TCP port nobody holds right now, also free on UDP for the QUIC cells. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createTcpServer();
      s.once('error', reject);
      s.listen(0, '0.0.0.0', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const udpFree = await new Promise<boolean>((resolve) => {
      const u = createSocket('udp4');
      u.once('error', () => resolve(false));
      u.bind(port, '0.0.0.0', () => u.close(() => resolve(true)));
    });
    if (udpFree) return port;
  }
  throw new Error('no free port');
}

/** Runs one sing-box on a config, keeping its output for the failure message. */
function run(name: string, config: unknown): { log: () => string } {
  const dir = mkdtempSync(join(tmpdir(), `iceslab-live-${name}-`));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  const child = spawn(SINGBOX_BIN, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  return { log: () => `--- ${name}\n${out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-15).join('\n')}` };
}

/**
 * One HTTP GET through a socks5 listener with username/password, by IP, so the
 * request does not depend on any resolver. Node has no socks client and this
 * is the whole protocol the test needs.
 */
function getThroughSocks(
  socksPort: number,
  password: string,
  target: number,
  opts: { user?: string; host?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socksPort, '127.0.0.1');
    sock.setTimeout(8000, () => sock.destroy(new Error('socks timeout')));
    let stage = 0;
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 2])));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[1] !== 2) return sock.destroy(new Error(`socks method ${buf[1]}`));
        const u = Buffer.from(opts.user ?? CHAIN_SOCKS_USER);
        const p = Buffer.from(password);
        sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        buf = buf.subarray(2);
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2) {
        if (buf[1] !== 0) return sock.destroy(new Error('socks auth refused'));
        const port = Buffer.alloc(2);
        port.writeUInt16BE(target);
        // By name when asked (ATYP 3), so a domain rule has a name to match;
        // by IP otherwise, so nothing depends on a resolver.
        const addr = opts.host
          ? Buffer.concat([Buffer.from([3, opts.host.length]), Buffer.from(opts.host)])
          : Buffer.from([1, 127, 0, 0, 1]);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, port]));
        buf = buf.subarray(2);
        stage = 2;
      }
      if (stage === 2 && buf.length >= 10) {
        if (buf[1] !== 0) return sock.destroy(new Error(`socks connect refused, code ${buf[1]}`));
        sock.write(`GET / HTTP/1.1\r\nHost: ${opts.host ?? '127.0.0.1'}:${target}\r\nConnection: close\r\n\r\n`);
        buf = buf.subarray(10);
        stage = 3;
      }
    });
    sock.on('end', () => (stage === 3 ? resolve(buf.toString()) : reject(new Error(`socks closed at stage ${stage}`))));
  });
}

async function eventually(fn: () => Promise<string>, ms: number): Promise<string> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
}

describe('a leg carries a request between two engines', () => {
  let http: Server;
  let httpPort = 0;
  const nonce = randomBytes(8).toString('hex');

  it.skipIf(!SINGBOX_BIN)('has a destination to reach', async () => {
    http = createHttpServer((_req, res) => res.end(nonce));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    httpPort = (http.address() as AddressInfo).port;
    expect(httpPort).toBeGreaterThan(0);
  });

  /** Both ends of one leg, as the panel renders them for this credential. */
  function renderPair(cred: LinkCred, socksPort: number, password: string) {
    const entryInput: ChainRenderInput = {
      role: 'entry',
      socksPassword: password,
      directionTags: [1],
      out: [{ tag: 1, host: '127.0.0.1', cred }],
    };
    const entry = renderChainConfig(entryInput) as { inbounds: { type: string; listen_port: number }[] };
    for (const i of entry.inbounds) if (i.type === 'socks') i.listen_port = socksPort;
    const exit = renderChainConfig({
      role: 'exit',
      socksPassword: password,
      in: {
        cred,
        clients: [
          {
            tag: 1,
            uuid: cred.protocol === 'vless' ? cred.uuid : undefined,
            shortId: cred.protocol === 'vless' ? cred.reality?.shortId : undefined,
          },
        ],
      },
    });
    return { entry, exit, entryInput };
  }

  /** Stops every running engine and waits until each has let go of its ports. */
  async function stopAll(): Promise<void> {
    await Promise.all(
      children.splice(0).map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.exitCode !== null || c.signalCode !== null) return resolve();
            c.once('exit', () => resolve());
            c.kill('SIGKILL');
          }),
      ),
    );
  }

  /** Runs one pair and sends the request; resolves with the body or rejects
   *  with the reason and both engines' last words. Leaves nothing running. */
  async function through(name: string, entry: unknown, exit: unknown, socksPort: number, password: string, ms = 15000) {
    const exitRun = run(`${name}-exit`, exit);
    const entryRun = run(`${name}-entry`, entry);
    try {
      return await eventually(async () => {
        // A reply without the nonce is a failure too: a socks listener can
        // accept, then close with nothing, and that is not a working leg.
        const body = await getThroughSocks(socksPort, password, httpPort);
        if (!body.includes(nonce)) throw new Error(`reply without the nonce: ${JSON.stringify(body.slice(0, 80))}`);
        return body;
      }, ms);
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}\n${exitRun.log()}\n${entryRun.log()}`);
    } finally {
      await stopAll();
    }
  }

  for (const cell of LINK_CELLS as readonly LinkCell[]) {
    it.skipIf(!SINGBOX_BIN)(
      `through ${cell}`,
      async () => {
        const socksPort = await freePort();
        const password = randomBytes(12).toString('hex');
        const cred = await newLinkCred(cell, await freePort());
        const { entry, exit } = renderPair(cred, socksPort, password);
        expect(await through(cell, entry, exit, socksPort, password)).toContain(nonce);
      },
      30000,
    );
  }

  /**
   * E24, the half the engines can check: a cell switch redraws BOTH ends so
   * that they agree, and one end left behind is exactly the outage the stand
   * had.
   *
   * The credentials come from generateTopologyLinks with the old leg as
   * `existing`, which is the call a save makes; only the port is moved to a free
   * one. The stale pair is run first on purpose: it proves the new pair works
   * because both ends moved, not because anything would have.
   */
  it.skipIf(!SINGBOX_BIN)(
    'survives a cell switch when both ends are redrawn, and not when one is left behind',
    async () => {
      const socksPort = await freePort();
      const linkPort = await freePort();
      const password = randomBytes(12).toString('hex');
      const legOf = async (cell: string, existing?: Map<string, LinkCred>) => {
        const [link] = await generateTopologyLinks(
          [{ nodeIds: ['entry'], linkProtocol: cell }],
          [{ tag: 1, nodeIds: ['exit'] }],
          existing,
        );
        return { ...link!.cred, port: linkPort } as LinkCred;
      };

      const before = await legOf('vless');
      const after = await legOf('hy2', new Map([[topologyLinkKey('entry', 'exit', 1), before]]));
      expect(after.protocol).toBe('hy2');

      const old = renderPair(before, socksPort, password);
      const fresh = renderPair(after, socksPort, password);
      expect(await through('vless', old.entry, old.exit, socksPort, password)).toContain(nonce);

      // The stand: the exit took the new leg, the entry kept dialling the old.
      await expect(through('stale-entry', old.entry, fresh.exit, socksPort, password, 4000)).rejects.toThrow();

      expect(await through('hy2', fresh.entry, fresh.exit, socksPort, password)).toContain(nonce);
    },
    60000,
  );

  /**
   * Phase 9.3: a route policy carried out by the chain at the entry, for real.
   * The entry's socks listener takes the profile as its user: `p1` is the
   * policy (for a hysteria entry, the cascade's entry policy), `p0` plain. A
   * name from the policy's rule-set is dropped for p1 and goes through for p0;
   * a neighbour the set does not name goes through for p1 as well.
   */
  it.skipIf(!SINGBOX_BIN)(
    'drops a name of the policy for its user, and lets the plain user and a neighbour through',
    async () => {
      const socksPort = await freePort();
      const password = randomBytes(12).toString('hex');
      const cred = await newLinkCred('shadowsocks', await freePort());
      const dir = mkdtempSync(join(tmpdir(), 'iceslab-live-policy-'));
      const ruleSetFile = join(dir, 'iceslab-geosite.category-ads-all.json');
      writeFileSync(ruleSetFile, JSON.stringify({ version: 2, rules: [{ domain: ['localhost'] }] }));
      const { policies, ruleSets } = chainPoliciesOf([
        { ordinal: 1, blockDomains: ['geosite:category-ads-all'], directDomains: [] },
      ]);
      const pair = renderPair(cred, socksPort, password);
      const entry = renderChainConfig({
        ...pair.entryInput,
        policies,
        ruleSets: ruleSets.map((r) => ({ tag: r.tag, path: ruleSetFile })),
      }) as { inbounds: { type: string; listen_port: number }[] };
      for (const i of entry.inbounds) if (i.type === 'socks') i.listen_port = socksPort;

      const exitRun = run('policy-exit', pair.exit);
      const entryRun = run('policy-entry', entry);
      const through = (user: string, host?: string) =>
        getThroughSocks(socksPort, password, httpPort, { user, ...(host ? { host } : {}) });
      try {
        // The neighbour first, which also waits for both engines to be up.
        expect(await eventually(() => through('p1'), 15000)).toContain(nonce);
        expect(await eventually(() => through('p0', 'localhost'), 5000)).toContain(nonce);
        // Dropped: the socks handshake completes and nothing comes back, or it
        // fails outright. Either way the page never arrives.
        const dropped = await through('p1', 'localhost').catch(() => '');
        expect(dropped).not.toContain(nonce);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n${exitRun.log()}\n${entryRun.log()}`);
      } finally {
        await stopAll();
      }
    },
    40000,
  );

  /**
   * A-102, for real: a shadowsocks leg into a transit with two ways out. The
   * leg carries one secret for both directions, so the transit cannot tell
   * them apart; route's default would send both out through the first. The
   * fallback for a shape stored before the save refused it drops both instead.
   * Without it, both requests below arrive.
   */
  it.skipIf(!SINGBOX_BIN)(
    'a transit that cannot tell two directions apart drops both instead of sending them out of the first',
    async () => {
      const password = randomBytes(12).toString('hex');
      const legIn = await newLinkCred('shadowsocks', await freePort());
      const outA = await newLinkCred('shadowsocks', await freePort());
      const outB = await newLinkCred('shadowsocks', await freePort());
      const entry = renderChainConfig({
        role: 'entry',
        socksPassword: password,
        directionTags: [1, 2],
        out: [
          { tag: 1, host: '127.0.0.1', cred: legIn },
          { tag: 2, host: '127.0.0.1', cred: legIn },
        ],
      }) as { inbounds: { type: string; tag: string; listen_port: number }[] };
      const socksPorts: number[] = [];
      for (const i of entry.inbounds) {
        if (i.type !== 'socks') continue;
        i.listen_port = await freePort();
        socksPorts.push(i.listen_port);
      }
      const transit = renderChainConfig({
        role: 'transit',
        socksPassword: password,
        in: { cred: legIn, clients: [{ tag: 1 }, { tag: 2 }] },
        out: [
          { tag: 1, host: '127.0.0.1', cred: outA },
          { tag: 2, host: '127.0.0.1', cred: outB },
        ],
      });
      const exitOf = (cred: LinkCred) =>
        renderChainConfig({ role: 'exit', socksPassword: password, in: { cred, clients: [{ tag: 1 }] } });
      // Exit B lets nothing out: a request that arrives went out through A.
      const exitB = exitOf(outB) as { route: { rules: Record<string, unknown>[] } };
      exitB.route.rules.unshift({ network: ['tcp', 'udp'], action: 'reject', method: 'drop' });
      expect(socksPorts).toHaveLength(2);

      /** One run of the four engines; the bodies each direction's socks got. */
      const once = async (name: string, transitConfig: unknown, wait: (port: number) => Promise<string>) => {
        const runs = [
          run(`${name}-exit-a`, exitOf(outA)),
          run(`${name}-exit-b`, exitB),
          run(`${name}-transit`, transitConfig),
          run(`${name}-entry`, entry),
        ];
        try {
          const bodies: string[] = [];
          for (const port of socksPorts) bodies.push(await wait(port));
          return { bodies, logs: () => runs.map((r) => r.log()).join('\n') };
        } finally {
          await stopAll();
        }
      };
      const arrives = (port: number) =>
        eventually(async () => {
          const body = await getThroughSocks(port, password, httpPort);
          if (!body.includes(nonce)) throw new Error('reply without the nonce');
          return body;
        }, 15000);

      // The control first, with the closing rule cut out of the transit: the
      // defect itself. Both directions arrive, and since exit B lets nothing
      // out, both went through A. This also proves the four engines, the ports
      // and the legs are up, so the real run below fails for the rule alone.
      const blind = structuredClone(transit) as { route: { rules: Record<string, unknown>[] } };
      blind.route.rules = blind.route.rules.filter((r) => !(r.action === 'reject' && 'network' in r));
      expect(blind.route.rules.length).toBe((transit as typeof blind).route.rules.length - 1);
      const control = await once('a102-control', blind, arrives);
      for (const body of control.bodies) expect(body, control.logs()).toContain(nonce);

      // With the rule: neither direction gets through.
      // The same engines came up in the control within seconds; give them that.
      let settled = false;
      const real = await once('a102', transit, async (port) => {
        if (!settled) {
          await new Promise((r) => setTimeout(r, 4000));
          settled = true;
        }
        return getThroughSocks(port, password, httpPort).catch(() => '');
      });
      for (const body of real.bodies) expect(body, real.logs()).not.toContain(nonce);
    },
    60000,
  );

  /**
   * A-111, the dial family, for real. The entry is addressed by an IPv4 literal
   * in the panel, the next hop by a name with both an A and an AAAA record
   * (`localhost`: 127.0.0.1 and ::1), and the exit listens on 127.0.0.1 only,
   * as a next hop's ufw lets in only the IPv4 source. Pinned to IPv4 the leg
   * arrives; the control pinned to IPv6 does not, which proves the pin is what
   * the engine dials by and not a lucky resolver order.
   */
  /**
   * The name has to carry BOTH families, or the positive half proves only that
   * IPv4 arrives anyway. Fails rather than skips: a machine without ::1 for
   * localhost cannot run this test, and saying so is the answer.
   */
  const assertDualStackLocalhost = async () => {
    const families = new Set((await lookup('localhost', { all: true })).map((a) => a.family));
    expect([...families].sort(), 'localhost must resolve to both 127.0.0.1 and ::1 for this test').toEqual([4, 6]);
  };

  const pinnedPair = async (selfHost: string) => {
    const socksPort = await freePort();
    const password = randomBytes(12).toString('hex');
    const cred = await newLinkCred('shadowsocks', await freePort());
    const pair = renderPair(cred, socksPort, password);
    const entry = renderChainConfig({
      ...pair.entryInput,
      selfHost,
      out: [{ tag: 1, host: 'localhost', cred }],
    }) as { inbounds: { type: string; listen_port: number }[] };
    for (const i of entry.inbounds) if (i.type === 'socks') i.listen_port = socksPort;
    const exit = pair.exit as { inbounds: { listen?: string }[] };
    for (const i of exit.inbounds) i.listen = '127.0.0.1';
    return { entry, exit, socksPort, password, cred };
  };

  it.skipIf(!SINGBOX_BIN)(
    'a sing-box leg from an IPv4 literal to a dual-stack name dials IPv4, and an IPv6 pin does not arrive',
    async () => {
      await assertDualStackLocalhost();
      const v4 = await pinnedPair('127.0.0.1');
      expect(JSON.stringify(v4.entry)).toContain('ipv4_only');
      expect(await through('pin-v4', v4.entry, v4.exit, v4.socksPort, v4.password)).toContain(nonce);
      const v6 = await pinnedPair('::1');
      expect(JSON.stringify(v6.entry)).toContain('ipv6_only');
      await expect(through('pin-v6', v6.entry, v6.exit, v6.socksPort, v6.password, 4000)).rejects.toThrow();
    },
    40000,
  );

  it.skipIf(!SINGBOX_BIN || !XRAY_BIN)(
    'a legacy xray shadowsocks leg from an IPv4 literal to a dual-stack name dials IPv4, and an IPv6 pin does not arrive',
    async () => {
      await assertDualStackLocalhost();
      const legacyEntry = (selfHost: string, cred: LinkCred, socksPort: number, password: string) => {
        const [entry, exitHop] = buildCascadeConfigs(
          [
            { nodeId: 'e', position: 0, nodeHost: selfHost },
            { nodeId: 'x', position: 1, nodeHost: 'localhost' },
          ] as never,
          [cred],
        );
        const linkOut = entry!.outbounds.find((o) => (o as { protocol?: string }).protocol === 'shadowsocks')!;
        // The legacy exit too: the xray link-out carries mux, which only an xray
        // link-in takes. On 127.0.0.1 only, as the next hop's ufw lets in.
        const exit = {
          log: { loglevel: 'warning' },
          inbounds: exitHop!.inbounds.map((i) => ({ ...i, listen: '127.0.0.1' })),
          outbounds: exitHop!.outbounds,
        };
        return {
          exit,
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port: socksPort,
              protocol: 'socks',
              settings: { auth: 'password', accounts: [{ user: CHAIN_SOCKS_USER, pass: password }] },
            },
          ],
          // The link-out first: xray sends what no rule names to the first outbound.
          outbounds: [linkOut],
        };
      };
      for (const [selfHost, arrives] of [
        ['127.0.0.1', true],
        ['::1', false],
      ] as const) {
        const p = await pinnedPair(selfHost);
        const entry = legacyEntry(selfHost, p.cred, p.socksPort, p.password);
        expect(JSON.stringify(entry)).toContain(arrives ? 'ForceIPv4' : 'ForceIPv6');
        const { exit, ...entryConfig } = entry;
        const exitRun = runXray(`xray-pin-${arrives ? 'v4' : 'v6'}-exit`, exit);
        const entryRun = runXray(`xray-pin-${arrives ? 'v4' : 'v6'}-entry`, entryConfig);
        try {
          const got = eventually(async () => {
            const body = await getThroughSocks(p.socksPort, p.password, httpPort);
            if (!body.includes(nonce)) throw new Error('reply without the nonce');
            return body;
          }, arrives ? 15000 : 4000);
          if (arrives) expect(await got).toContain(nonce);
          else await expect(got).rejects.toThrow();
        } catch (err) {
          throw new Error(`${(err as Error).message}\n${exitRun.log()}\n${entryRun.log()}`);
        } finally {
          await stopAll();
        }
      }
    },
    60000,
  );

  afterAll(() => http?.close());
});
