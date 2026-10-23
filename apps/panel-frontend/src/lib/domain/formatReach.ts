import {
  clientSecurityLayer,
  transportServed,
  XRAY_TRANSPORT_SUBPROTOCOLS,
  type ClientSecurityLayer,
  type SubscriptionTransportFormat,
} from '@iceslab/shared';

/**
 * Which subscription clients will not get an xray endpoint (A-224), read from
 * the shared table the format builders use (`transportServed`,
 * packages/shared/src/transport-support.ts, BACK d6b04a06 and e585b3e7), not
 * from a copy of it (A-196). One function for the profile page and the host
 * page: the host may override the profile's security, so the layer is a
 * parameter, not a second copy. The names are the clients as operators know
 * them (the delivery screen's own names); the share link is the one of the
 * endpoint's subprotocol.
 *
 * Only the xray family is asked: socks and http are not in the table, and
 * «nobody gets it» there would be a false sentence. An empty list draws no line.
 */
export type ClientFormat = 'singbox' | 'clash' | 'xrayjson' | 'surge' | 'quantumultx' | 'loon' | 'v2rayn';

const CLIENTS: { client: ClientFormat; format: (sub: string) => SubscriptionTransportFormat }[] = [
  { client: 'singbox', format: () => 'singbox' },
  { client: 'clash', format: () => 'clash' },
  { client: 'xrayjson', format: () => 'xrayjson' },
  { client: 'surge', format: () => 'surge' },
  { client: 'quantumultx', format: () => 'quantumultx' },
  { client: 'loon', format: () => 'loon' },
  { client: 'v2rayn', format: (sub) => `${sub}-link` as SubscriptionTransportFormat },
];

// The layer a client sees is the shared rule (A-230, BACK ba3fdf5c,
// packages/shared/src/transport-support.ts `clientSecurityLayer`): a host
// override of tls or none wins, else the profile's own, and vmess over
// REALITY or with no security is none. The copy that stood here is gone.
export type HostSecurity = ClientSecurityLayer;

export function clientsLeftOut(endpoint: {
  subprotocol: string;
  network: string;
  /** The profile's own security word: reality, tls or none. */
  security: string;
  xhttpMode?: string;
  /** The host's override, when the line is said for a host. */
  hostSecurity?: HostSecurity | null;
}): ClientFormat[] {
  if (!(XRAY_TRANSPORT_SUBPROTOCOLS as readonly string[]).includes(endpoint.subprotocol)) return [];
  const e = {
    subprotocol: endpoint.subprotocol,
    network: endpoint.network,
    xhttpMode: endpoint.xhttpMode,
    securityLayer: clientSecurityLayer(
      { subprotocol: endpoint.subprotocol, security: endpoint.security },
      endpoint.hostSecurity,
    ),
  };
  return CLIENTS.filter(({ format }) => !transportServed(format(endpoint.subprotocol), e)).map((c) => c.client);
}

/** Whether any host of a profile sets its own security; `null` hosts (the
 *  list did not arrive) is «cannot tell», which keeps the caveat on. */
export function hostsMaySecureOtherwise(hosts: readonly { securityLayer?: string | null }[] | null): boolean {
  if (hosts === null) return true;
  return hosts.some((h) => h.securityLayer === 'tls' || h.securityLayer === 'none');
}
