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

function endpoint(
  network: Network,
  over: 'reality' | 'tls' | 'none' = 'reality',
): SubscriptionEndpoint {
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
    ...(over === 'none' ? { securityLayer: 'none' as const } : {}),
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
    // No `degraded` and no `dropped` anywhere: every cell either carries the
    // transport or declines the endpoint. `omitted` is not a shrug - it is the
    // client having no spelling for that transport at all, established per
    // client in `cannotCarryTransport`, and the alternative was an entry that
    // imports cleanly and never connects.
    expect('\n' + render() + '\n').toBe(`
transport   xrayjson    clash       singbox     loon        surge       quantumultx
raw         carried     carried     carried     carried     omitted     carried
xhttp       carried     carried     omitted     omitted     omitted     omitted
ws          carried     carried     carried     carried     omitted     carried
grpc        carried     carried     carried     carried     omitted     omitted
httpupgrade carried     carried     carried     omitted     omitted     omitted
kcp         carried     carried     omitted     omitted     omitted     omitted
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
    // Empty, and it has to stay empty. This is the assertion that would catch
    // the defect coming back: a format that starts emitting an endpoint whose
    // transport it cannot express lands here, whatever the table above says.
    expect(broken.sort()).toEqual([]);
  });

  it('Surge emits only the transports it can spell, in the branch it does emit', () => {
    // Surge's whole column of `omitted` above is REALITY, which it does not do
    // at all. This is the other branch - trojan over real TLS - which the table
    // cannot see and where the same defect lived: an entry used to come out for
    // every transport while naming none but ws, so five of six dialled plain
    // TLS at a server not listening for it.
    const emitted = NETWORKS.filter((n) =>
      buildSurgeConf([endpoint(n, 'tls')]).includes('n1.example.com'),
    );
    expect(emitted).toEqual(['raw', 'ws']);
    expect(buildSurgeConf([endpoint('ws', 'tls')])).toContain('ws=true');
  });

  it('Vision rides RAW and XHTTP only, in every format that emits it', () => {
    // `xtls-rprx-vision` splices the TLS record layer, so it only works when the
    // stream IS the TLS stream: RAW and XHTTP. Over ws/grpc/httpupgrade/kcp it
    // is not a weaker config, it is one the core refuses.
    //
    // Reachable by DEFAULT, not in a corner: `flow` defaults to
    // `xtls-rprx-vision` and the inbound schema says outright that the panel
    // "doesn't enforce this at write time, the operator must align flow +
    // network themselves". `core-adapters/xray/uri.ts` has always got it right,
    // which is why the plain URI list is fine and only the rich formats were not.
    const emitters = (n: Network): string[] => {
      const one = [endpoint(n)];
      const seen: string[] = [];
      const has = (name: string, out: string) => {
        if (out.includes('xtls-rprx-vision')) seen.push(name);
      };
      has('xrayjson', buildXrayJson(one));
      has('clash', buildClashYaml(one));
      has('singbox', buildSingboxJson(one));
      has('loon', buildLoonConf(one));
      has('quantumultx', buildQuantumultXConf(one));
      return seen;
    };

    // Where Vision belongs, every format that emits the endpoint carries it.
    expect(emitters('raw')).toEqual(['xrayjson', 'clash', 'singbox', 'loon', 'quantumultx']);
    // xhttp: only the two that still emit an xhttp endpoint at all.
    expect(emitters('xhttp')).toEqual(['xrayjson', 'clash']);
    // ...and nowhere else, in any format, ever.
    expect(emitters('ws')).toEqual([]);
    expect(emitters('grpc')).toEqual([]);
    expect(emitters('httpupgrade')).toEqual([]);
    expect(emitters('kcp')).toEqual([]);

    // The other half of the rule, and it needs its own case: Vision also wants a
    // TLS-like layer, so RAW with `securityLayer: none` must carry no flow
    // either. That half was spelled out in four separate formats and asserted in
    // none of them - deleting it from all four passed the whole module's suite.
    // Centralising the rule made that a ONE-line edit, so it gets a test.
    const bare = [endpoint('raw', 'none')];
    for (const out of [
      buildXrayJson(bare),
      buildClashYaml(bare),
      buildSingboxJson(bare),
      buildLoonConf(bare),
      buildQuantumultXConf(bare),
    ]) {
      expect(out).not.toContain('xtls-rprx-vision');
    }
  });

  it('a fleet the format cannot carry degrades to an empty config, not a broken one', () => {
    // Skipping made the empty fleet a NORMAL outcome rather than a corner: s1's
    // current inbound is VLESS+XHTTP+REALITY, so for these four formats an
    // xhttp-only fleet is every endpoint gone. Which is the honest answer - the
    // project's own client survey already says SINGBOX/STASH/CLASH do not work
    // against that inbound - but only if what comes out is still loadable.
    //
    // sing-box is the one that could go wrong: a config whose `route.final`
    // names a selector with no members is not an empty config, it is one the
    // client refuses to start. It falls back to `direct` instead.
    const xhttpOnly = [endpoint('xhttp')];
    const singbox = JSON.parse(buildSingboxJson(xhttpOnly));
    expect(singbox.outbounds.map((o: { tag: string }) => o.tag)).toEqual(['direct']);
    expect(singbox.route.final).toBe('direct');

    // The proxy-line formats have nothing to dangle, and say nothing.
    expect(buildLoonConf(xhttpOnly)).toBe('');
    expect(buildSurgeConf(xhttpOnly)).toBe('');
    expect(buildQuantumultXConf(xhttpOnly)).toBe('');

    // ...and Mihomo is unaffected, because it actually implements XHTTP. If
    // this ever goes false, the skip has been copied to a format that did not
    // need it and real endpoints are being dropped.
    expect(buildClashYaml(xhttpOnly)).toContain('type: vless');
  });

  it('QuantumultX spells WebSocket the way its own sample.conf does', () => {
    // The one cell where the transport could actually be RENDERED rather than
    // declined. Asserted as the whole line, because the parts are what make it
    // work: `wss` is QX's way of saying WebSocket AND TLS at once, `obfs-uri`
    // carries the path, and Vision is absent on purpose - it rides RAW or XHTTP
    // only, so over WebSocket it is not a weaker config but an invalid one.
    const line = buildQuantumultXConf([endpoint('ws')]).trim();
    expect(line).toBe(
      'vless=n1.example.com:443, method=none, password=11111111-2222-3333-4444-555555555555, ' +
        'obfs=wss, obfs-host=www.cloudflare.com, obfs-uri=/dl, ' +
        'reality-base64-pubkey=pk, reality-hex-shortid=abc123, udp-relay=true, tag=eu-1',
    );
    expect(line).not.toContain('vless-flow');
  });
});
