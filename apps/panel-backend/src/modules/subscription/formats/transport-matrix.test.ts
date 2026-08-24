/**
 * What each subscription format does with each xray stream transport.
 *
 * Not a correctness test - a CHARACTERISATION one. It renders the same endpoint
 * six ways and writes down what comes out, because the thing worth knowing here
 * cannot be seen one format at a time: several of these emit a server entry that
 * looks entirely valid and cannot connect, ever. The project already has a name
 * for the trade this is about ("an empty section in a client is a bad outcome; a
 * server entry that fails every connect and says nothing is worse") and a
 * mechanism for taking the first option (`cannotCarryVlessEncryption`), applied
 * to VLESS-Encryption and to nothing else.
 *
 * The defect is LATENT: by default every client is handed the plain base64 URI
 * list, and `core-adapters/xray/uri.ts` renders all six transports correctly. It
 * arms the day an operator writes an SRR delivery rule pointing sing-box, Loon
 * or QuantumultX at one of these formats.
 *
 * WHAT THIS FILE ASSERTS is only what WE emit, never what a third-party client
 * accepts. Whether mihomo understands `network: xhttp` is a question about
 * mihomo, and guessing at it here would put an unverifiable claim in a test.
 * `degraded` and `dropped` are read off our own output and need no such guess.
 *
 * The per-format decision - skip the endpoint, or render the transport properly -
 * is a product one and has not been taken. Until it is, this table is what makes
 * the question concrete, and it fails the moment any cell moves.
 */
import { describe, expect, it } from 'vitest';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson } from './xrayjson.js';
import { buildLoonConf } from './loon.js';
import { buildSurgeConf } from './surge.js';
import { buildQuantumultXConf } from './quantumultx.js';
import type { SubscriptionEndpoint } from '../subscription.formats.js';

const NETWORKS = ['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp'] as const;
type Network = (typeof NETWORKS)[number];

/**
 * `carried`  - our output names this endpoint's transport
 * `degraded` - our output names a DIFFERENT transport; the client dials that one
 *              and never reaches the server
 * `dropped`  - an entry with no transport information at all, which the client
 *              reads as plain TCP: the same outcome as `degraded`, quieter
 * `omitted`  - no entry emitted for this endpoint
 *
 * For `raw` there is nothing to carry, so having no transport block IS the
 * correct rendering and counts as `carried`.
 */
type Verdict = 'carried' | 'degraded' | 'dropped' | 'omitted';

function endpoint(network: Network, over: 'reality' | 'tls' = 'reality'): SubscriptionEndpoint {
  return {
    protocol: 'xray',
    nodeName: 'eu-1',
    host: 'n1.example.com',
    port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    publicKey: 'pk',
    shortId: 'abc123',
    sni: 'www.cloudflare.com',
    flow: 'xtls-rprx-vision',
    fingerprint: 'chrome',
    network,
    path: '/dl',
    serviceName: 'gsvc',
    ...(over === 'tls' ? { securityLayer: 'tls' as const, subprotocol: 'trojan' as const } : {}),
    uri: `vless://u@n1.example.com:443?type=${network}`,
  } as SubscriptionEndpoint;
}

/** Read a verdict off rendered text, given how that format names transports. */
function verdictFrom(
  out: string,
  network: Network,
  opts: { entryMarker: string; slot: (n: string) => string; tcpName: string },
): Verdict {
  if (!out.includes(opts.entryMarker)) return 'omitted';
  // `slot` is a TEMPLATE over the transport name, never a list of the ones the
  // format handles today. Written as a list, a format that started carrying
  // `xhttp` tomorrow would read as `dropped` and stay on the broken list - the
  // table would go on accusing a renderer that had been fixed, which is the one
  // way a characterisation test can be worse than no test.
  if (out.includes(opts.slot(network))) return 'carried';
  if (network === 'raw') return 'carried';
  if (opts.tcpName && out.includes(opts.tcpName)) return 'degraded';
  return 'dropped';
}

function matrix(): Record<Network, Record<string, Verdict>> {
  const rows = {} as Record<Network, Record<string, Verdict>>;
  for (const n of NETWORKS) {
    const one = [endpoint(n)];
    const singbox = JSON.parse(buildSingboxJson(one));
    const vless = (singbox.outbounds ?? []).find((o: { type?: string }) => o.type === 'vless');
    const stream = JSON.parse(buildXrayJson(one)).outbounds?.[0]?.streamSettings ?? {};

    rows[n] = {
      xrayjson:
        stream.network === n && (n === 'raw' || Object.keys(stream).some((k) => k.startsWith(n)))
          ? 'carried'
          : 'degraded',
      clash: verdictFrom(buildClashYaml(one), n, {
        entryMarker: 'type: vless',
        slot: (t) => `network: ${t}`,
        tcpName: 'network: tcp',
      }),
      // sing-box has no transport block for `raw`, so absence is correct there
      // and only there.
      singbox: !vless
        ? 'omitted'
        : vless.transport
          ? vless.transport.type === n
            ? 'carried'
            : 'degraded'
          : n === 'raw'
            ? 'carried'
            : 'dropped',
      loon: verdictFrom(buildLoonConf(one), n, {
        entryMarker: '= VLESS,',
        slot: (t) => `transport:${t}`,
        tcpName: 'transport:tcp',
      }),
      // Surge and QuantumultX have no single transport slot to template over -
      // Surge spells ws as `ws=true`, QX folds it into `obfs=`. Both are matched
      // on the transport name appearing ANYWHERE in the line, which is loose in
      // their favour: it can call a fixed renderer `carried` by accident, but it
      // cannot call a broken one carried, and it is the accusation that has to
      // be safe.
      surge: verdictFrom(buildSurgeConf(one), n, {
        entryMarker: 'n1.example.com',
        slot: (t) => t,
        tcpName: '',
      }),
      quantumultx: verdictFrom(buildQuantumultXConf(one), n, {
        entryMarker: 'vless=',
        slot: (t) => t,
        tcpName: '',
      }),
    };
  }
  return rows;
}

function render(): string {
  const rows = matrix();
  const cols = Object.keys(rows.raw);
  const head = ['transport'.padEnd(12), ...cols.map((c) => c.padEnd(12))].join('');
  const body = NETWORKS.map((n) =>
    [n.padEnd(12), ...cols.map((c) => rows[n][c].padEnd(12))].join('').trimEnd(),
  );
  return [head.trimEnd(), ...body].join('\n');
}

describe('subscription formats against xray stream transports', () => {
  it('the table, exactly as it stands today', () => {
    // Observed, not designed. Every `degraded` and every `dropped` here is a
    // config we hand a client that cannot reach the server it names.
    expect('\n' + render() + '\n').toBe(`
transport   xrayjson    clash       singbox     loon        surge       quantumultx
raw         carried     carried     carried     carried     omitted     carried
xhttp       carried     carried     dropped     degraded    omitted     dropped
ws          carried     carried     carried     carried     omitted     dropped
grpc        carried     carried     carried     carried     omitted     dropped
httpupgrade carried     carried     carried     degraded    omitted     dropped
kcp         carried     carried     dropped     degraded    omitted     dropped
`);
  });

  it('names every format that emits an endpoint it cannot carry', () => {
    const rows = matrix();
    const broken: string[] = [];
    for (const n of NETWORKS) {
      for (const [fmt, verdict] of Object.entries(rows[n])) {
        if (verdict === 'degraded' || verdict === 'dropped') broken.push(`${fmt}:${n}`);
      }
    }
    // One list, so the product decision has one place to land: each of these
    // either starts rendering its transport, or stops emitting the endpoint.
    // `omitted` is deliberately absent - Surge declining VLESS over REALITY
    // outright is the choice, not the defect.
    expect(broken.sort()).toEqual([
      'loon:httpupgrade',
      'loon:kcp',
      'loon:xhttp',
      'quantumultx:grpc',
      'quantumultx:httpupgrade',
      'quantumultx:kcp',
      'quantumultx:ws',
      'quantumultx:xhttp',
      'singbox:kcp',
      'singbox:xhttp',
    ]);
  });

  it('Surge declines VLESS over REALITY, and carries only ws when it does emit', () => {
    // Surge's whole column of `omitted` is a decision, not a transport bug: it
    // skips REALITY entirely. Where it DOES emit - trojan over real TLS - the
    // same question returns, and only `ws` survives.
    const carried = NETWORKS.filter((n) => buildSurgeConf([endpoint(n, 'tls')]).includes('ws=true'));
    expect(carried).toEqual(['ws']);
    for (const n of NETWORKS) {
      // The entry is emitted for every transport while carrying no hint of any
      // but ws, so five of the six dial plain TLS at a server not listening for
      // it. Same defect as the table above, in the branch the table cannot see.
      expect(buildSurgeConf([endpoint(n, 'tls')])).toContain('n1.example.com');
    }
  });
});
