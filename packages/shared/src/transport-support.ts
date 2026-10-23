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
 *   - Stash (A-236, stash.wiki/en/proxy-protocols/proxy-types, read
 *     2026-10-23): vless over tcp, ws, h2, http, grpc and xhttp (xhttp-opts
 *     carries the mode; "iOS/tvOS3.6+ macOS4.3+"), vmess over ws, h2, http,
 *     grpc, trojan over ws, grpc, REALITY "on every transport" of all three;
 *     no httpupgrade, no kcp.
 *   - legacy Clash (A-236, clash.wiki/configuration/outbound.html, read
 *     2026-10-23): ss, ssr, vmess, socks5, http, snell, trojan; vmess over
 *     tcp, ws, h2, http, grpc, trojan over tcp, ws, grpc; no vless, no REALITY.
 *
 * A cell is a rule, not only yes or no, because the security layer decides
 * some of them: Surge has no REALITY, QX writes WebSocket as obfs=ws|wss
 * (never REALITY), and QX trojan takes WebSocket over TLS only.
 */

import { FORMAT_DOORS, type Door, type FormatDoor, type SubscriptionFormat } from './transport.js';

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
  // The two YAML dialects of the template types (A-236): no `?format=` of
  // their own yet, the clash builder frames them until step 4 of the plan.
  'stash',
  'clash-legacy',
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
  stash: {
    // XHTTP needs Stash iOS/tvOS 3.6+ or macOS 4.3+ (stash.wiki proxy-types,
    // the XHTTP subsection); older Stash does not dial it.
    vless: { ...NONE, raw: 'served', ws: 'served', grpc: 'served', xhttp: 'served', 'xhttp-mode': 'served' },
    vmess: { ...NONE, raw: 'served', ws: 'served', grpc: 'served' },
    trojan: { ...NONE, raw: 'served', ws: 'served', grpc: 'served' },
  },
  'clash-legacy': {
    vless: NONE,
    vmess: { ...NONE, raw: 'served', ws: 'served', grpc: 'served' },
    // Trojan in legacy Clash is TLS: no REALITY, and nothing without a TLS layer.
    trojan: { ...NONE, raw: 'tls-only', ws: 'tls-only', grpc: 'tls-only' },
  },
};

// ---------------------------------------------------------------- templates

/**
 * The kinds of operator template (A-236, docs/plan/subscription-templates
 * 4.1 and the API contract 4.5a), the format each one frames, and what each
 * one carries: the doors and the transports. One table with the transport
 * table above, not a second one.
 *
 * A template is a frame the operator writes and the panel fills: their
 * `proxy-groups`, their rules, our nodes. The TYPE is what the operator picked
 * in the editor; the FORMAT is what `/sub` answers with when that template is
 * in force.
 *
 * ⚠ `stash` and `clash` (legacy) frame the `clash` format until their own
 * answers ship (step 4 of the plan): neither is a `?format=` yet, and naming
 * one in TEMPLATE_FORMATS would be a promise this build cannot serve. What
 * they CARRY is already theirs (TEMPLATE_DOORS, TEMPLATE_TRANSPORT), so step 4
 * has only to point the builder at it.
 */
export const TEMPLATE_TYPES = ['mihomo', 'stash', 'clash', 'singbox', 'xray-json-array', 'xray-json'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const TEMPLATE_FORMATS: Record<TemplateType, SubscriptionFormat> = {
  mihomo: 'clash',
  stash: 'clash',
  clash: 'clash',
  singbox: 'singbox',
  'xray-json-array': 'xrayjson-array',
  'xray-json': 'xrayjson',
};

/** The row of the transport table a template type reads. */
export const TEMPLATE_TRANSPORT: Record<TemplateType, SubscriptionTransportFormat> = {
  mihomo: 'clash',
  stash: 'stash',
  clash: 'clash-legacy',
  singbox: 'singbox',
  'xray-json-array': 'xrayjson',
  'xray-json': 'xrayjson',
};

const DOOR_YES: FormatDoor = { carried: true };
const DOOR_LACKS: FormatDoor = { carried: false, why: 'client-lacks-protocol' };

/**
 * The doors of the two dialects with no format of their own, every door said
 * (a new door is a type error here, and the composition test asks for it). The
 * other types carry what their format carries, FORMAT_DOORS, and are not
 * written twice.
 *   - Stash: ss, socks5, http, vmess, trojan, vless, hysteria2, tuic, anytls,
 *     mieru; no ShadowTLS, NaiveProxy, MTProto; wireguard without the
 *     AmneziaWG obfuscation.
 *   - legacy Clash: ss, socks5, http, vmess, trojan; nothing newer.
 */
const DIALECT_DOORS: Record<'stash' | 'clash', Record<Door, FormatDoor>> = {
  stash: {
    vless: DOOR_YES, vmess: DOOR_YES, trojan: DOOR_YES, socks: DOOR_YES, http: DOOR_YES,
    hysteria: DOOR_YES, shadowsocks: DOOR_YES, tuic: DOOR_YES, anytls: DOOR_YES, mieru: DOOR_YES,
    shadowtls: DOOR_LACKS, naive: DOOR_LACKS, amneziawg: DOOR_LACKS, mtproto: DOOR_LACKS,
  },
  clash: {
    vmess: DOOR_YES, trojan: DOOR_YES, socks: DOOR_YES, http: DOOR_YES, shadowsocks: DOOR_YES,
    vless: DOOR_LACKS, hysteria: DOOR_LACKS, tuic: DOOR_LACKS, anytls: DOOR_LACKS, mieru: DOOR_LACKS,
    shadowtls: DOOR_LACKS, naive: DOOR_LACKS, amneziawg: DOOR_LACKS, mtproto: DOOR_LACKS,
  },
};

/** The doors a template type carries. */
export function templateDoors(type: TemplateType): Record<Door, FormatDoor> {
  return type === 'stash' || type === 'clash' ? DIALECT_DOORS[type] : FORMAT_DOORS[TEMPLATE_FORMATS[type]];
}

/**
 * Does a template type carry this endpoint: its door (and the door's security
 * layer, Surge-style), then, for an xray door, its transport. One answer, the
 * door asked first, as /formats asks it (A-231).
 */
export function templateCarries(
  type: TemplateType,
  e: { door: Door; network?: string; xhttpMode?: string; securityLayer?: ClientSecurityLayer },
): boolean {
  const cell = templateDoors(type)[e.door];
  if (!cell.carried) return false;
  if (cell.exceptReality && (e.securityLayer ?? 'default') === 'default') return false;
  if (!(XRAY_TRANSPORT_SUBPROTOCOLS as readonly string[]).includes(e.door)) return true;
  return transportServed(TEMPLATE_TRANSPORT[type], { subprotocol: e.door, ...e });
}

/**
 * The security layer a client sees on an xray endpoint (A-230): 'default' is
 * REALITY. One rule for the subscription, the profile's /formats answer and
 * the panel's screens, which each held a copy until they drifted:
 *   - a host override of tls or none wins over the profile;
 *   - else the profile's own security, REALITY when it names none;
 *   - vmess has no REALITY: a vmess row stored as REALITY (written before the
 *     schema refused it) is served as none, which is what its share link
 *     already said.
 */
export type ClientSecurityLayer = 'default' | 'tls' | 'none';

export function clientSecurityLayer(
  config: { subprotocol?: string | null; security?: string | null } | null | undefined,
  hostOverride?: string | null,
): ClientSecurityLayer {
  const layer: ClientSecurityLayer =
    hostOverride === 'tls' || hostOverride === 'none'
      ? hostOverride
      : config?.security === 'none'
        ? 'none'
        : config?.security === 'tls'
          ? 'tls'
          : 'default';
  return config?.subprotocol === 'vmess' && layer === 'default' ? 'none' : layer;
}

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
