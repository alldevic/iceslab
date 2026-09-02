import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTopologyFragmentsForNode } from './cascade.config.js';

/**
 * Ask xray itself whether the fragments we generate form a config it will load.
 *
 * Every other cascade test checks STRUCTURE: which tags exist, what the rules
 * point at. None of them can answer the only question that matters on a node -
 * will the core start. On 2026-08-08 that gap cost us both cascade entries:
 * `vlessRoute` went out as an array of numbers, xray parsed it with its
 * port-list parser, rejected the whole config, and the cores sat in a crash
 * loop. 88 green tests and a clean typecheck said nothing (BACKLOG E10).
 *
 * Skipped when no xray binary is around, so a laptop without one still runs the
 * suite. Point XRAY_BIN at a binary (or install one at the usual path) to have
 * it actually run; CI should do exactly that.
 *
 * It had never run on the lab host until 2026-08-26 — eight tests, silently
 * skipped for as long as they have existed, which is the quietest way for a
 * check to be worth nothing. The binary now sits at
 * `/var/tmp/iceslab-vmlab/xray` (26.3.27, copied off the fleet's own node):
 *
 *     XRAY_BIN=/var/tmp/iceslab-vmlab/xray corepack pnpm test
 *
 * Confirmed the check can fail before trusting it: `xray -test` exits 23 with
 * the parse error on a bad config and 0 with "Configuration OK." on a good one,
 * and reintroducing the E10 defect (vlessRoute as an array) turns these red
 * with xray's own words — "invalid port: [1,257] > json: cannot unmarshal array
 * into Go value of type uint32", the port-list parser this file was written
 * about. Two mutations were tried and a structural test caught both as well, so
 * today these eight are the second opinion rather than the only one; what they
 * uniquely cover is everything xray rejects that nobody thought to assert.
 */
const XRAY_BIN =
  process.env.XRAY_BIN ??
  ['/usr/local/bin/xray', '/usr/bin/xray'].find((p) => existsSync(p)) ??
  '';

const N = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENTRY = N(1);
const TRANSIT = N(2);
const EXIT_A = N(3);
const EXIT_B = N(4);

/**
 * Wrap our fragments in the smallest config xray will accept, mirroring what
 * the node-agent renders around them: a client-facing inbound plus the base
 * `direct`/`blocked` outbounds our routing rules refer to.
 */
function wrap(fragment: ReturnType<typeof buildTopologyFragmentsForNode>): string {
  return JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'vless-in',
        port: 443,
        listen: '0.0.0.0',
        protocol: 'vless',
        settings: { clients: [{ id: N(9) }], decryption: 'none' },
        streamSettings: { network: 'raw', security: 'none' },
      },
      ...(fragment?.inbounds ?? []),
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'blocked', protocol: 'blackhole' },
      ...(fragment?.outbounds ?? []).filter((o) => o.tag !== 'direct'),
    ],
    routing: {
      rules: fragment?.routingRules ?? [],
      ...(fragment?.balancers ? { balancers: fragment.balancers } : {}),
    },
    // Top-level, exactly where the node-agent puts it: a leastPing balancer
    // has no pings without it, and xray rejects the whole config.
    ...(fragment?.observatory ? { observatory: fragment.observatory } : {}),
  });
}

function xrayAccepts(config: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'iceslab-xray-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, config);
  try {
    const out = execFileSync(XRAY_BIN, ['-test', '-c', file], { encoding: 'utf8' });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

const link = (from: string, to: string, directionTag: number, port: number) => ({
  fromNodeId: from,
  toNodeId: to,
  directionTag,
  cred: { protocol: 'vless' as const, port, uuid: `${N(directionTag)}` },
});

const hosts = new Map([
  [ENTRY, 'entry.example'],
  [TRANSIT, 'transit.example'],
  [EXIT_A, 'exit-a.example'],
  [EXIT_B, 'exit-b.example'],
]);

describe.skipIf(!XRAY_BIN)('xray accepts the generated cascade config', () => {
  // Entry with two directions: the shape that broke in the field. Its rules
  // carry vlessRoute, which is exactly the field that was malformed.
  const twoDirections = {
    positions: [{ position: 0, nodeIds: [ENTRY] }],
    directions: [
      { tag: 1, nodeIds: [EXIT_A] },
      { tag: 2, nodeIds: [EXIT_B] },
    ],
    links: [link(ENTRY, EXIT_A, 1, 24000), link(ENTRY, EXIT_B, 2, 24000)],
    hosts,
    policies: [{ ordinal: 1, directDomains: ['ads.example'], blockDomains: ['bad.example'] }],
  };

  it('loads the entry config', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(ENTRY, twoDirections)));
    expect(r.ok, r.output).toBe(true);
  });

  // Bridge A: the entry grows a loopback socks inbound plus an inboundTag rule.
  // Structure tests cannot answer whether xray takes a `socks` inbound with
  // `sniffing` in this position, or whether `inboundTag` is accepted alongside
  // the vlessRoute rules - and a config the core refuses is a crash loop that
  // takes the whole entry down, tagged clients included.
  it('loads an entry that bridges its non-xray cores', () => {
    const oneDirection = {
      positions: [{ position: 0, nodeIds: [ENTRY] }],
      directions: [{ tag: 1, nodeIds: [EXIT_A] }],
      links: [link(ENTRY, EXIT_A, 1, 24000)],
      hosts,
      bridgeSocksPort: 24100,
      // A literal domain matcher, not geosite/geoip: those need the .dat
      // databases on disk, and their absence fails the config for a reason
      // that has nothing to do with what this case is testing. (It failed
      // exactly that way first - `failed to open file: geoip.dat`.)
      egressPolicies: new Map([[ENTRY, [{ domain: ['split.example'], target: 'direct' as const }]]]),
    };
    const fragment = buildTopologyFragmentsForNode(ENTRY, oneDirection);
    // Control: without the bridge inbound in it, this test would be asserting
    // that xray accepts a plain entry, which the case above already covers.
    expect(fragment!.inbounds.some((i) => i.tag === 'cascade-bridge-in')).toBe(true);
    const r = xrayAccepts(wrap(fragment));
    expect(r.ok, r.output).toBe(true);
  });

  // Bridge B: the entry grows a TRANSPARENT inbound - a dokodemo-door with
  // `sockopt.tproxy` and `followRedirect`. Whether xray takes that shape is not
  // something a structure test can answer, and it is the shape that decides
  // whether the wg channel exists at all: a config the core refuses is a crash
  // loop that takes the entry down for every client on it, tagged ones
  // included. Bridge A's own version of this case caught a real defect.
  it('loads an entry that bridges its kernel cores', () => {
    const oneDirection = {
      positions: [{ position: 0, nodeIds: [ENTRY] }],
      directions: [{ tag: 1, nodeIds: [EXIT_A] }],
      links: [link(ENTRY, EXIT_A, 1, 24000)],
      hosts,
      bridgeTproxyPort: 24101,
      // Literal matchers only - geosite/geoip need the .dat files on disk and
      // would fail this for a reason unrelated to the case.
      egressPolicies: new Map([[ENTRY, [{ domain: ['split.example'], target: 'direct' as const }]]]),
    };
    const fragment = buildTopologyFragmentsForNode(ENTRY, oneDirection);
    // Control: without the transparent inbound actually in the fragment, this
    // would be asserting that xray loads a plain entry, which is covered above.
    expect(fragment!.inbounds.some((i) => i.tag === 'cascade-bridge-tproxy-in')).toBe(true);
    const r = xrayAccepts(wrap(fragment));
    expect(r.ok, r.output).toBe(true);
  });

  // Both bridges at once, which is what s1 runs: one xray carrying a socks
  // inbound for sing-box and a transparent one for the kernel, and two
  // inboundTag rules beside the vlessRoute ones.
  it('loads an entry that bridges both kinds of core at once', () => {
    const fragment = buildTopologyFragmentsForNode(ENTRY, {
      positions: [{ position: 0, nodeIds: [ENTRY] }],
      directions: [{ tag: 1, nodeIds: [EXIT_A] }],
      links: [link(ENTRY, EXIT_A, 1, 24000)],
      hosts,
      bridgeSocksPort: 24100,
      bridgeTproxyPort: 24101,
    });
    expect(fragment!.inbounds.some((i) => i.tag === 'cascade-bridge-in')).toBe(true);
    expect(fragment!.inbounds.some((i) => i.tag === 'cascade-bridge-tproxy-in')).toBe(true);
    const r = xrayAccepts(wrap(fragment));
    expect(r.ok, r.output).toBe(true);
  });

  it('loads a direction (exit) config', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(EXIT_A, twoDirections)));
    expect(r.ok, r.output).toBe(true);
  });

  // Transit plus several directions is the shape the old model could not
  // express at all, so it has never been near a real core.
  const withTransit = {
    positions: [
      { position: 0, nodeIds: [ENTRY] },
      { position: 1, nodeIds: [TRANSIT] },
    ],
    directions: [
      { tag: 1, nodeIds: [EXIT_A] },
      { tag: 2, nodeIds: [EXIT_B] },
    ],
    links: [
      link(ENTRY, TRANSIT, 1, 24000),
      link(ENTRY, TRANSIT, 2, 24000),
      link(TRANSIT, EXIT_A, 1, 24001),
      link(TRANSIT, EXIT_B, 2, 24001),
    ],
    hosts,
    policies: [],
  };

  it('loads a transit config, where routing matches on the link credential', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(TRANSIT, withTransit)));
    expect(r.ok, r.output).toBe(true);
  });

  // REALITY + VISION wrapping of the leg. Its own corner of the parser: keys
  // must decode, VISION must be named on both ends, and mux must be absent
  // (xray refuses VISION together with multiplexing).
  const realityLink = {
    ...twoDirections,
    links: [
      {
        ...link(ENTRY, EXIT_A, 1, 24000),
        cred: {
          protocol: 'vless' as const,
          port: 24000,
          uuid: N(5),
          reality: {
            // base64URL, no padding - the form `xray x25519` emits and the
            // only one the config validator accepts. Standard base64 is
            // rejected outright, which is what generateRealityKeyPair produces
            // correctly and this test originally got wrong.
            privateKey: Buffer.alloc(32, 7).toString('base64url'),
            publicKey: Buffer.alloc(32, 9).toString('base64url'),
            shortId: '0123456789abcdef',
            serverName: 'www.microsoft.com',
            dest: 'www.microsoft.com:443',
          },
        },
      },
    ],
    directions: [{ tag: 1, nodeIds: [EXIT_A] }],
  };

  it('loads an entry whose link is wrapped in REALITY', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(ENTRY, realityLink)));
    expect(r.ok, r.output).toBe(true);
  });

  it('loads the receiving side of a REALITY link', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(EXIT_A, realityLink)));
    expect(r.ok, r.output).toBe(true);
  });

  // A pool on the next step turns into a balancer; balancers and their selectors
  // are a separate corner of xray's config parser.
  it('loads an entry whose direction is served by a pool', () => {
    const pooled = {
      positions: [{ position: 0, nodeIds: [ENTRY] }],
      directions: [{ tag: 1, nodeIds: [EXIT_A, EXIT_B] }],
      links: [link(ENTRY, EXIT_A, 1, 24000), link(ENTRY, EXIT_B, 1, 24000)],
      hosts,
      policies: [],
    };
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(ENTRY, pooled)));
    expect(r.ok, r.output).toBe(true);
  });

  // Auto adds a second balancer next to any per-direction ones, sharing the one
  // observatory. Two balancers over overlapping selectors is a shape xray has
  // never been asked about here, and the cost of guessing wrong is the entry's
  // core refusing to start at all.
  it('loads an entry that offers the Auto profile', () => {
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(ENTRY, { ...twoDirections, auto: true })));
    expect(r.ok, r.output).toBe(true);
  });

  it('loads an Auto entry whose directions are pools', () => {
    const both = {
      positions: [{ position: 0, nodeIds: [ENTRY] }],
      directions: [
        { tag: 1, nodeIds: [EXIT_A, EXIT_B] },
        { tag: 2, nodeIds: [TRANSIT] },
      ],
      links: [
        link(ENTRY, EXIT_A, 1, 24000),
        link(ENTRY, EXIT_B, 1, 24000),
        link(ENTRY, TRANSIT, 2, 24000),
      ],
      hosts,
      policies: [{ ordinal: 1, directDomains: ['ads.example'], blockDomains: ['bad.example'] }],
      auto: true,
    };
    const r = xrayAccepts(wrap(buildTopologyFragmentsForNode(ENTRY, both)));
    expect(r.ok, r.output).toBe(true);
  });
});
