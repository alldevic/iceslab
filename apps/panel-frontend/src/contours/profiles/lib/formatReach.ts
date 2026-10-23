import { transportServed, XRAY_TRANSPORT_SUBPROTOCOLS, type SubscriptionTransportFormat } from '@iceslab/shared';

/**
 * Which subscription clients will not get this xray profile (A-224), read
 * from the shared table the format builders use (`transportServed`,
 * packages/shared/src/transport-support.ts, BACK d6b04a06 and e585b3e7), not
 * from a copy of it (A-196). The names are the clients as operators know
 * them; the share link is the one of the profile's own subprotocol.
 *
 * Only the xray family is asked: socks and http are not in the table, and
 * «nobody gets it» there would be a false sentence. An empty list draws no line.
 */
export type ClientFormat = 'singbox' | 'clash' | 'surge' | 'quantumultx' | 'loon' | 'v2rayn';

const CLIENTS: { client: ClientFormat; format: (sub: string) => SubscriptionTransportFormat }[] = [
  { client: 'singbox', format: () => 'singbox' },
  { client: 'clash', format: () => 'clash' },
  { client: 'surge', format: () => 'surge' },
  { client: 'quantumultx', format: () => 'quantumultx' },
  { client: 'loon', format: () => 'loon' },
  { client: 'v2rayn', format: (sub) => `${sub}-link` as SubscriptionTransportFormat },
];

/** The stored security word to the table's layer: REALITY is its `default`. */
function securityLayer(security: string): string {
  return security === 'reality' ? 'default' : security;
}

export function clientsLeftOut(profile: {
  subprotocol: string;
  network: string;
  security: string;
  xhttpMode?: string;
}): ClientFormat[] {
  if (!(XRAY_TRANSPORT_SUBPROTOCOLS as readonly string[]).includes(profile.subprotocol)) return [];
  const endpoint = {
    subprotocol: profile.subprotocol,
    network: profile.network,
    xhttpMode: profile.xhttpMode,
    securityLayer: securityLayer(profile.security),
  };
  return CLIENTS.filter(({ format }) => !transportServed(format(profile.subprotocol), endpoint)).map((c) => c.client);
}
