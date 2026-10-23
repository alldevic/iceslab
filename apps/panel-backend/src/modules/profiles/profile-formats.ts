import {
  FORMAT_NAMES,
  PROTOCOL_NAMES,
  doorOf,
  formatCarries,
  type Door,
  type FormatWhy,
  type ProtocolName,
  type SubscriptionFormat,
  type XraySubprotocol,
  clientSecurityLayer as sharedSecurityLayer,
  transportServed,
  XRAY_TRANSPORT_SUBPROTOCOLS,
  type ClientSecurityLayer,
  type SubscriptionTransportFormat,
  type XrayTransportSubprotocol,
} from '@iceslab/shared';

/**
 * Which subscription formats carry a profile's door, and why not where they
 * do not: GET /api/profiles/:id/formats. The host screen draws its per-format
 * switches from it, so a switch for a format that never carries this profile
 * reads as such instead of being a toggle that changes nothing.
 *
 * Read from FORMAT_DOORS through formatCarries, the same function the
 * subscription gate uses (endpointsForFormat), so the screen and the file a
 * client receives are one decision.
 */
export interface ProfileFormat {
  format: SubscriptionFormat;
  carried: boolean;
  /** FormatWhy for the door; `client-lacks-transport` when the door is
   *  carried and the profile's transport is not (A-231). */
  why: FormatWhy | 'client-lacks-transport';
  /**
   * A-231: the one reason a format leaves the profile out, null when it
   * carries it. `door` = the protocol, or its security layer (Surge has no
   * REALITY); `transport` = the door is carried, its network is not (the
   * shared transport table). One reason per format: the door is asked first,
   * so a format that lacks both says `door` once.
   */
  reason: 'door' | 'transport' | null;
}

export interface ProfileFormats {
  door: Door;
  formats: ProfileFormat[];
}

type SecurityLayer = ClientSecurityLayer;

/** The security layer a client sees on this profile's endpoints: the shared
 *  rule (A-230), the one the subscription service uses. */
export function clientSecurityLayer(config: unknown, hostOverride?: SecurityLayer | null): SecurityLayer {
  return sharedSecurityLayer(config as { subprotocol?: string; security?: string } | null, hostOverride);
}

export function profileFormats(
  storedProtocol: string,
  config: unknown,
  hostOverride?: SecurityLayer | null,
): ProfileFormats {
  // The column is a string; the schema only ever writes a ProtocolName.
  if (!(PROTOCOL_NAMES as readonly string[]).includes(storedProtocol)) {
    throw new Error(`profile protocol "${storedProtocol}" is not one this panel knows`);
  }
  const protocol = storedProtocol as ProtocolName;
  const sub = (config as { subprotocol?: XraySubprotocol } | null)?.subprotocol;
  const door = doorOf({ protocol, subprotocol: protocol === 'xray' ? sub : undefined });
  const security = protocol === 'xray' ? clientSecurityLayer(config, hostOverride) : undefined;
  // The cipher decides Outline (no 2022-blake3 there); absent, formatCarries
  // answers as carried.
  const ssMethod =
    protocol === 'shadowsocks' ? (config as { method?: string } | null)?.method : undefined;
  const xray = (config ?? {}) as { network?: string; xhttpMode?: string };
  return {
    door,
    formats: FORMAT_NAMES.map((format): ProfileFormat => {
      const byDoor = formatCarries(format, door, security, ssMethod);
      if (!byDoor.carried) return { format, ...byDoor, reason: 'door' };
      const table = transportFormatOf(format, door);
      if (
        table &&
        !transportServed(table, { subprotocol: door, network: xray.network, xhttpMode: xray.xhttpMode, securityLayer: security })
      ) {
        return { format, carried: false, why: 'client-lacks-transport', reason: 'transport' };
      }
      return { format, ...byDoor, reason: null };
    }),
  };
}

/**
 * The transport table's name for a subscription format, for the doors the
 * table covers (vless, vmess, trojan); null where the transport decides
 * nothing: the panel's own JSON dump carries everything, and the other doors
 * have no xray transport. The plain list is the share links of the door.
 */
function transportFormatOf(format: SubscriptionFormat, door: Door): SubscriptionTransportFormat | null {
  if (!(XRAY_TRANSPORT_SUBPROTOCOLS as readonly string[]).includes(door)) return null;
  switch (format) {
    case 'plain':
      return `${door as XrayTransportSubprotocol}-link`;
    case 'xrayjson':
    case 'xrayjson-array':
    case 'xkeen':
      return 'xrayjson';
    case 'clash':
    case 'singbox':
    case 'quantumultx':
    case 'loon':
    case 'surge':
      return format;
    default:
      return null;
  }
}
