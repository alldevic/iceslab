import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_TRANSPORT_FORMATS,
  TRANSPORT_SUPPORT,
  XRAY_TRANSPORT_COLUMNS,
  XRAY_TRANSPORT_SUBPROTOCOLS,
  transportColumn,
  transportServed,
  type SubscriptionTransportFormat,
  type TransportSupportCell,
  type XrayTransportColumn,
} from '@iceslab/shared';
import type { SubscriptionEndpoint } from '../subscription.formats.js';
import { buildClashYaml } from './clash.js';
import { buildSingboxJson } from './singbox.js';
import { buildXrayJson, buildXrayJsonArray } from './xrayjson.js';
import { buildQuantumultXConf } from './quantumultx.js';
import { buildLoonConf } from './loon.js';
import { buildSurgeConf } from './surge.js';
import { buildVlessRealityUri } from '../../../core-adapters/xray/uri.js';
import { buildVmessUri } from '../../../core-adapters/xray/vmess-uri.js';
import { buildTrojanRealityUri } from '../../../core-adapters/xray/trojan-uri.js';

/**
 * A-224: every cell of the shared transport table, against what the format
 * actually writes. One endpoint per (format, subprotocol, column, security),
 * built by the format itself, and its presence in the output must be what the
 * cell says. A row taken out of the table fails here: the walk is over the
 * full product of the exported lists, not over the table's own keys.
 */

const SECURITIES = ['default', 'tls', 'none'] as const;
const NO_BUILDER_YET = ['stash', 'clash-legacy'] as const;

function expected(cell: TransportSupportCell, sec: (typeof SECURITIES)[number]): boolean {
  if (cell === 'served') return true;
  if (cell === 'skipped') return false;
  if (cell === 'not-reality') return sec !== 'default';
  return sec === 'tls';
}

function endpoint(sub: string, column: XrayTransportColumn, sec: string): SubscriptionEndpoint {
  const network = column === 'xhttp-mode' ? 'xhttp' : column;
  return {
    protocol: 'xray',
    nodeName: `cell-${sub}-${column}-${sec}`,
    host: 'n.example.com',
    port: 443,
    uuid: '11111111-1111-4111-8111-111111111111',
    publicKey: 'PUBKEY',
    shortId: 'SHORT',
    sni: 'www.example.com',
    flow: '',
    fingerprint: 'chrome',
    network,
    path: '/p',
    hostHeader: 'cdn.example.com',
    serviceName: 'svc',
    ...(column === 'xhttp-mode' ? { xhttpMode: 'stream-one' as const } : {}),
    subprotocol: sub as 'vless' | 'vmess' | 'trojan',
    securityLayer: sec as 'default' | 'tls' | 'none',
    uri: '',
  } as SubscriptionEndpoint;
}

/** Whether the format put this endpoint out. Links: the builder for the link's
 *  own subprotocol writes it; the table says whether the service keeps it. */
function present(format: SubscriptionTransportFormat, e: SubscriptionEndpoint): boolean {
  const x = e as SubscriptionEndpoint & { subprotocol: string; network: string; securityLayer: string };
  switch (format) {
    case 'clash':
      return buildClashYaml([e]).includes(e.nodeName);
    case 'singbox':
      return buildSingboxJson([e]).includes(e.nodeName);
    case 'xrayjson': {
      // xray-json tags outbounds by id, not by name: ask for the proxy itself.
      const cfg = JSON.parse(buildXrayJson([e])) as { outbounds?: Array<{ protocol?: string }> };
      return (cfg.outbounds ?? []).some((o) => o.protocol === x.subprotocol);
    }
    case 'quantumultx':
      return buildQuantumultXConf([e]).includes(e.nodeName);
    case 'loon':
      return buildLoonConf([e]).includes(e.nodeName);
    case 'surge':
      return buildSurgeConf([e]).includes(e.nodeName);
    default: {
      const sub = format.replace('-link', '');
      if (x.subprotocol !== sub) return false;
      // The builders always write a link for their own subprotocol; the cell
      // is applied by the service (uri '' when skipped). Asked here as the
      // service asks, through the table's own reading of the endpoint.
      return true;
    }
  }
}

describe('the shared transport table against the formats', () => {
  for (const format of SUBSCRIPTION_TRANSPORT_FORMATS) {
    for (const sub of XRAY_TRANSPORT_SUBPROTOCOLS) {
      for (const column of XRAY_TRANSPORT_COLUMNS) {
        it(`${format} / ${sub} / ${column}`, () => {
          const row = TRANSPORT_SUPPORT[format]?.[sub];
          expect(row, `no row for ${format}/${sub}`).toBeDefined();
          const cell = row![column];
          expect(cell, `no cell for ${format}/${sub}/${column}`).toBeDefined();
          // The template dialects with no builder of their own yet (A-236): the
          // clash builder frames them until step 4, so there is no file to hold
          // the cell against. Their cells are held to the client docs in
          // template-support.test.ts; this entry goes when the builder comes.
          if ((NO_BUILDER_YET as readonly string[]).includes(format)) return;
          if (format.endsWith('-link')) {
            // A link family carries only its own subprotocol, and xray's links
            // carry every network.
            const own = format === `${sub}-link`;
            expect(cell).toBe(own ? 'served' : 'skipped');
            return;
          }
          for (const sec of SECURITIES) {
            const e = endpoint(sub, column, sec);
            expect(present(format, e), `${format}/${sub}/${column}/${sec}`).toBe(expected(cell, sec));
          }
        });
      }
    }
  }

  it('a network the table does not know is carried by no format, not read as raw', () => {
    for (const format of SUBSCRIPTION_TRANSPORT_FORMATS) {
      for (const sub of XRAY_TRANSPORT_SUBPROTOCOLS) {
        expect(transportServed(format, { subprotocol: sub, network: 'quic', securityLayer: 'tls' }), `${format}/${sub}`).toBe(false);
      }
    }
    expect(transportColumn('quic')).toBeNull();
    expect(transportColumn(undefined)).toBe('raw');
    expect(transportColumn('tcp')).toBe('raw');
    for (const format of ['clash', 'singbox', 'xrayjson', 'quantumultx', 'loon', 'surge'] as const) {
      const e = { ...endpoint('vless', 'raw', 'tls'), network: 'quic', nodeName: 'cell-unknown-net' } as SubscriptionEndpoint;
      expect(present(format, e), format).toBe(false);
    }
  });

  it('a format or subprotocol the table does not know answers false, not a throw', () => {
    expect(transportServed('no-such-format' as SubscriptionTransportFormat, { subprotocol: 'vless' })).toBe(false);
    expect(transportServed('wireguard-link' as SubscriptionTransportFormat, { subprotocol: 'wireguard' })).toBe(false);
    expect(transportServed('clash', { subprotocol: 'wireguard', network: 'raw' })).toBe(false);
  });

  it('xray-json obeys a narrowed cell on every path: the flat file, the array and xkeen', () => {
    const ws = endpoint('vless', 'ws', 'tls');
    const raw = endpoint('vless', 'raw', 'tls');
    const protocols = (json: string) => {
      const parsed = JSON.parse(json) as unknown;
      const cfgs = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ outbounds?: Array<{ protocol?: string }> }>;
      return cfgs.flatMap((c) => (c.outbounds ?? []).filter((o) => o.protocol === 'vless'));
    };
    const paths = {
      flat: () => buildXrayJson([ws, raw]),
      array: () => buildXrayJsonArray([ws, raw]),
      xkeen: () => buildXrayJson([ws, raw], { forRouter: true }),
    };
    for (const build of Object.values(paths)) expect(protocols(build())).toHaveLength(2);

    const saved = TRANSPORT_SUPPORT.xrayjson.vless;
    TRANSPORT_SUPPORT.xrayjson.vless = { ...saved, ws: 'skipped' };
    try {
      for (const [name, build] of Object.entries(paths)) {
        expect(protocols(build()), name).toHaveLength(1);
      }
    } finally {
      TRANSPORT_SUPPORT.xrayjson.vless = saved;
    }
  });

  it('the link builders write every network of their subprotocol, the XHTTP mode included', () => {
    for (const column of XRAY_TRANSPORT_COLUMNS) {
      const e = endpoint('vless', column, 'tls') as SubscriptionEndpoint & { network: 'raw' };
      const base = { host: e.host, port: e.port, name: e.nodeName, network: e.network, path: '/p', hostHeader: 'h', serviceName: 's' };
      const mode = column === 'xhttp-mode' ? 'stream-one' : undefined;
      expect(buildVlessRealityUri({ ...base, uuid: 'u', publicKey: 'k', shortId: 's', sni: 'x', xhttpMode: mode })).toMatch(/^vless:\/\//);
      expect(buildTrojanRealityUri({ ...base, password: 'p', publicKey: 'k', shortId: 's', sni: 'x', xhttpMode: mode })).toMatch(/^trojan:\/\//);
      expect(buildVmessUri({ ...base, uuid: 'u', xhttpMode: mode })).toMatch(/^vmess:\/\//);
    }
  });
});
