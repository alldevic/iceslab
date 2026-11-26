import { acmeHostnameFor } from '../inbounds/acme-hostname.js';
import { hostFromAddress } from '../subscription/subscription.formats.js';

/**
 * The shape of nodes.hysteria_tls and its public face (E30a), apart from the
 * minting in hysteria-tls.ts so the mapper and the subscription read it
 * without pulling in x509 and the database.
 */

/** As stored in nodes.hysteria_tls. The key never leaves the panel but to the node. */
export interface StoredHysteriaTls {
  certPem: string;
  keyPem: string;
  /** The host in the certificate's SAN: the node's address when it was minted. */
  host: string;
  /** sha256 of the DER, lowercase hex, no colons: what clients pin. */
  certSha256: string;
  createdAt: string;
}

/** What the node DTO shows: the intent, never the key. */
export interface PublicHysteriaTls {
  certSha256: string;
  host: string;
  createdAt: string;
}

/** The stored value as the code reads it; anything else is null. */
export function readHysteriaTls(raw: unknown): StoredHysteriaTls | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  for (const k of ['certPem', 'keyPem', 'host', 'certSha256', 'createdAt']) {
    if (typeof r[k] !== 'string' || !r[k]) return null;
  }
  return r as unknown as StoredHysteriaTls;
}

export function publicHysteriaTls(raw: unknown): PublicHysteriaTls | null {
  const t = readHysteriaTls(raw);
  return t ? { certSha256: t.certSha256, host: t.host, createdAt: t.createdAt } : null;
}

/**
 * The host a node's self-signed certificate is for, or null when the node has
 * a name ACME takes (then there is no self-signed certificate at all).
 */
export function selfSignedHostFor(address: string | null | undefined): string | null {
  if (!address || acmeHostnameFor(address)) return null;
  const host = hostFromAddress(address.trim()).toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare || null;
}

/** What a subscription pins for one hysteria endpoint. */
export interface HysteriaTlsPin {
  /** sha256 of the DER, lowercase hex, no colons. */
  certSha256: string;
  /** The certificate itself, for the clients that take it as their anchor. */
  certPem: string;
  /** The name in its SAN, for the clients that check it. */
  serverName: string;
}

/** What the pin of a node is read from: its address, the pair the panel
 *  minted, and the core inventory the agent reported. */
export interface HysteriaPinSource {
  address: string;
  hysteriaTls: unknown;
  cores: unknown;
}

/**
 * The pin of a hysteria endpoint by the core that serves it, or null when it
 * has none.
 *
 * Native hysteria serves the panel's pair: null on a node with an FQDN (ACME),
 * with no pair minted yet, or with a pair minted for an address the node no
 * longer has (the next push re-mints it; a pin for the old one would not match).
 *
 * sing-box serves the certificate its bootstrap generated, for a name of its
 * own and not for the node's address, so the address plays no part: the pin is
 * what the agent reported on the hysteria[singbox] row. null when it reported
 * nothing (an agent older than the report, or a node not polled yet) or a
 * certificate a CA issued.
 */
export function hysteriaPinFor(engine: string | undefined, node: HysteriaPinSource): HysteriaTlsPin | null {
  if (engine === 'singbox') return singboxPinFor(node.cores);
  if (engine !== 'hysteria') return null;
  const host = selfSignedHostFor(node.address);
  const t = readHysteriaTls(node.hysteriaTls);
  if (!host || !t || t.host !== host) return null;
  return { certSha256: t.certSha256, certPem: t.certPem, serverName: t.host };
}

/** The pin from the tls fact of the hysteria[singbox] row of the inventory
 *  (`nodes.cores`), or null when it has no complete self-signed one. */
export function singboxPinFor(raw: unknown): HysteriaTlsPin | null {
  const cores = (raw as { cores?: unknown } | null)?.cores;
  if (!Array.isArray(cores)) return null;
  const row = cores.find(
    (c): c is { tls?: unknown } =>
      !!c && typeof c === 'object' && (c as { name?: unknown }).name === 'hysteria' && (c as { engine?: unknown }).engine === 'singbox',
  );
  const tls = row?.tls as Record<string, unknown> | undefined;
  if (!tls || tls.source !== 'self-signed') return null;
  const { certSha256, certPem, serverName } = tls;
  if (typeof certSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(certSha256)) return null;
  if (typeof certPem !== 'string' || !certPem.includes('-----BEGIN CERTIFICATE-----')) return null;
  if (typeof serverName !== 'string' || !serverName) return null;
  return { certSha256, certPem, serverName };
}
