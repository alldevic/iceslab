/**
 * Which subscription formats give THIS person something, and which of those
 * a client may be offered for.
 *
 * Two questions, asked of the same endpoints and the same gates:
 *
 *   carriedFormats  the format's file would carry at least one endpoint, by
 *                   FORMAT_DOORS and the host switches (the download rows);
 *   usableFormats   the same, and after the transport table: a client of that
 *                   format would also get a server it can dial.
 *
 * The second is narrower on purpose. A builder LEAVES OUT an endpoint whose
 * transport its client cannot speak (sing-box has no XHTTP), which is right for
 * the file and wrong for the page: on a fleet that is all XHTTP, a sing-box
 * client handed this subscription imports an empty config and looks as if it
 * worked. The file may still be downloaded (the row stays, `carriedFormats`),
 * the client is simply not recommended.
 *
 * Answered from the tables the builders consult (formatDisabledForHost,
 * endpointsForFormat, transportServed), not by rendering each file, so it is
 * cheap enough for every page view. What it cannot see is a reason a builder
 * drops an endpoint that is in none of those tables: such a client stays
 * offered. The store document (milestone 14.6) calls the same functions.
 */
import {
  FORMAT_NAMES,
  formatDisabledForHost,
  transportServed,
  type SubscriptionFormat,
  type SubscriptionTransportFormat,
} from '@iceslab/shared';
import { endpointsForFormat, isPlainXray, type SubscriptionEndpoint } from './subscription.formats.js';

/** The row of the transport table a format's builder reads. A format absent here
 *  has no transport of its own to miss (the whole-dump and per-node ones). */
const TRANSPORT_ROW: Partial<Record<SubscriptionFormat, SubscriptionTransportFormat>> = {
  clash: 'clash',
  mihomo: 'clash',
  stash: 'stash',
  'clash-legacy': 'clash-legacy',
  singbox: 'singbox',
  xrayjson: 'xrayjson',
  'xrayjson-array': 'xrayjson',
  xkeen: 'xrayjson',
  surge: 'surge',
  quantumultx: 'quantumultx',
  loon: 'loon',
};

/** What the file of `format` carries: the host switches, then the door table. */
function carriedBy(format: SubscriptionFormat, endpoints: SubscriptionEndpoint[]): SubscriptionEndpoint[] {
  return endpointsForFormat(
    format,
    endpoints.filter((e) => !formatDisabledForHost(e.disableForFormats, format)),
  );
}

/** Does a client of `format` get this endpoint, transport included? */
function transportOk(format: SubscriptionFormat, e: SubscriptionEndpoint): boolean {
  // Only an xray proxy line has a transport the table judges; the Telegram doors
  // (socks, http) and every other protocol are one connection shape.
  if (e.protocol !== 'xray' || isPlainXray(e)) return true;
  // The links formats: a share link is the table's to give or not, and no link
  // is no line (subscription.service.ts).
  const row = TRANSPORT_ROW[format] ?? (format === 'plain' || format === 'raw' ? (`${e.subprotocol ?? 'vless'}-link` as const) : undefined);
  return row === undefined || transportServed(row, e);
}

/** The formats whose file carries something for these endpoints. */
export function carriedFormats(endpoints: SubscriptionEndpoint[]): SubscriptionFormat[] {
  return FORMAT_NAMES.filter((f) => carriedBy(f, endpoints).length > 0);
}

/** The formats a client may be offered for: the file carries something a client
 *  of that format can dial. */
export function usableFormats(endpoints: SubscriptionEndpoint[]): SubscriptionFormat[] {
  return FORMAT_NAMES.filter((f) => carriedBy(f, endpoints).some((e) => transportOk(f, e)));
}
