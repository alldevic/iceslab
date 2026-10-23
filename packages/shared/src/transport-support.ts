/**
 * Which subscription format carries which xray transport (A-224).
 *
 * One table for the backend's format builders, which decide here whether an
 * endpoint goes out or is left out, and for the panel's profile screen, which
 * says it to the operator. Every cell was read in the client's own docs or
 * source (A-133, 22.10; the format files name the anchors):
 *   - Quantumult X: sample.conf, `obfs=ws|wss`, trojan "over-tls=true or
 *     obfs=wss"; no gRPC, XHTTP, httpupgrade or kcp.
 *   - Loon: nsloon.app/en/docs/Node, `transport=tcp|ws`.
 *   - Surge: manual.nssurge.com policies/vmess, policies/trojan: WebSocket
 *     only; no VLESS and no REALITY at all.
 *   - Clash/mihomo: wiki.metacubex.one proxies/{vless,vmess,trojan} and
 *     transport: xhttp on VLESS only, httpupgrade as ws with
 *     v2ray-http-upgrade, mKCP left out (its seed and header are not in the
 *     endpoint).
 *   - sing-box: configuration/shared/v2ray-transport: http, ws, quic, grpc,
 *     httpupgrade; "No mKCP transport", no XHTTP.
 *   - xray-json and the share links: xray itself; the vmess link's XHTTP mode
 *     rides `type` (v2rayN VmessFmt.cs, ResolveVmess).
 *
 * A cell is a rule, not only yes or no, because the security layer decides
 * some of them: Surge has no REALITY, QX writes WebSocket as obfs=ws|wss
 * (never REALITY), and QX trojan takes WebSocket over TLS only.
 */

export const SUBSCRIPTION_TRANSPORT_FORMATS = [
  'clash',
  'singbox',
  'xrayjson',
  'quantumultx',
  'loon',
  'surge',
  'vless-link',
  'vmess-link',
  'trojan-link',
] as const;
export type SubscriptionTransportFormat = (typeof SUBSCRIPTION_TRANSPORT_FORMATS)[number];

export const XRAY_TRANSPORT_SUBPROTOCOLS = ['vless', 'vmess', 'trojan'] as const;
export type XrayTransportSubprotocol = (typeof XRAY_TRANSPORT_SUBPROTOCOLS)[number];

/** The networks, and XHTTP with a mode that is not auto as its own column:
 *  a format may carry XHTTP and have nowhere to say the mode. */
export const XRAY_TRANSPORT_COLUMNS = ['raw', 'ws', 'httpupgrade', 'grpc', 'xhttp', 'xhttp-mode', 'kcp'] as const;
export type XrayTransportColumn = (typeof XRAY_TRANSPORT_COLUMNS)[number];

/**
 * served         goes out;
 * skipped        left out;
 * not-reality    goes out over TLS or none, left out over REALITY;
 * tls-only       goes out over TLS only.
 */
export type TransportSupportCell = 'served' | 'skipped' | 'not-reality' | 'tls-only';

type Row = Record<XrayTransportColumn, TransportSupportCell>;
type Table = Record<SubscriptionTransportFormat, Record<XrayTransportSubprotocol, Row>>;

const ALL: Row = {
  raw: 'served', ws: 'served', httpupgrade: 'served', grpc: 'served', xhttp: 'served', 'xhttp-mode': 'served', kcp: 'served',
};
const RAW_WS: Row = {
  raw: 'served', ws: 'served', httpupgrade: 'skipped', grpc: 'skipped', xhttp: 'skipped', 'xhttp-mode': 'skipped', kcp: 'skipped',
};
const NONE: Row = {
  raw: 'skipped', ws: 'skipped', httpupgrade: 'skipped', grpc: 'skipped', xhttp: 'skipped', 'xhttp-mode': 'skipped', kcp: 'skipped',
};
const SINGBOX: Row = {
  raw: 'served', ws: 'served', httpupgrade: 'served', grpc: 'served', xhttp: 'skipped', 'xhttp-mode': 'skipped', kcp: 'skipped',
};
const CLASH_NO_XHTTP: Row = { ...SINGBOX };
const SURGE: Row = { ...NONE, raw: 'not-reality', ws: 'not-reality' };

export const TRANSPORT_SUPPORT: Table = {
  clash: { vless: { ...ALL, kcp: 'skipped' }, vmess: CLASH_NO_XHTTP, trojan: CLASH_NO_XHTTP },
  singbox: { vless: SINGBOX, vmess: SINGBOX, trojan: SINGBOX },
  xrayjson: { vless: ALL, vmess: ALL, trojan: ALL },
  quantumultx: {
    vless: { ...NONE, raw: 'served', ws: 'not-reality' },
    vmess: { ...NONE, raw: 'served', ws: 'not-reality' },
    trojan: { ...NONE, raw: 'served', ws: 'tls-only' },
  },
  loon: { vless: RAW_WS, vmess: RAW_WS, trojan: RAW_WS },
  surge: { vless: NONE, vmess: SURGE, trojan: SURGE },
  'vless-link': { vless: ALL, vmess: NONE, trojan: NONE },
  'vmess-link': { vless: NONE, vmess: ALL, trojan: NONE },
  'trojan-link': { vless: NONE, vmess: NONE, trojan: ALL },
};

/**
 * The column an endpoint falls in, or null for a network the table does not
 * know. No network at all is raw (the schema's default), and `tcp` is raw's
 * old name (inbounds.schemas.ts normalises it on write; a row written before
 * that still says it). Anything else is NOT raw: reading it as raw is what
 * hands a client bare TCP to a node that listens on something else.
 */
export function transportColumn(network: string | undefined, xhttpMode?: string): XrayTransportColumn | null {
  const n = !network || network === 'tcp' ? 'raw' : network;
  if (n === 'xhttp') return xhttpMode && xhttpMode !== 'auto' ? 'xhttp-mode' : 'xhttp';
  return (XRAY_TRANSPORT_COLUMNS as readonly string[]).includes(n) ? (n as XrayTransportColumn) : null;
}

/**
 * Does `format` carry this xray endpoint? `security` is the endpoint's layer:
 * 'default' (REALITY), 'tls' or 'none'. What the table does not know is not
 * carried: an unknown format, subprotocol or network answers false, never a
 * throw. The subprotocol and network come from stored jsonb through a cast, so
 * an old or hand-written value reaches here, and one bad profile must not
 * take the whole subscription down with it.
 */
export function transportServed(
  format: SubscriptionTransportFormat,
  e: { subprotocol?: string; network?: string; xhttpMode?: string; securityLayer?: string },
): boolean {
  const sub = (e.subprotocol ?? 'vless') as XrayTransportSubprotocol;
  const row = TRANSPORT_SUPPORT[format]?.[sub];
  if (!row) return false;
  const column = transportColumn(e.network, e.xhttpMode);
  if (column === null) return false;
  const cell = row[column];
  const sec = e.securityLayer ?? 'default';
  switch (cell) {
    case 'served':
      return true;
    case 'skipped':
      return false;
    case 'not-reality':
      return sec !== 'default';
    case 'tls-only':
      return sec === 'tls';
  }
}
