import { NETWORKS_CARRYING_VISION } from '@iceslab/shared';

/**
 * Xray stream transports each carry their own settings, but a profile stores one
 * flat config, so switching transport leaves the previous one's fields behind.
 *
 * Inert while they sit there (the node renders only the settings block matching
 * `network`), and misleading the moment the operator switches back: the transport
 * silently comes up with a value typed months ago and forgotten. Found in the
 * field 2026-08-08 on a profile that had moved gRPC -> XHTTP and still carried
 * `serviceName: GunService` - the default name from xray's own documentation,
 * recognisable from outside, which nobody would pick deliberately.
 *
 * So a saved profile keeps only the fields its transport actually uses.
 *
 * Deliberately limited to TRANSPORT fields. The REALITY keypair and the TLS
 * cert/key are identity material shared across transports: dropping them when
 * `security` changes would invalidate every link already handed out (clients
 * carry `pbk`) and, for TLS, throw away an operator-supplied certificate. Stale
 * transport settings are a papercut; those would be data loss.
 */

/** Which fields each transport owns. Absent transport (raw, kcp) owns none. */
const FIELDS_BY_NETWORK: Record<string, readonly string[]> = {
  ws: ['path', 'host'],
  httpupgrade: ['path', 'host'],
  xhttp: ['path', 'host', 'xhttpMode', 'xhttpPaddingBytes'],
  grpc: ['serviceName', 'grpcMultiMode'],
};

/**
 * `flow` is not owned by a transport, but its VALIDITY is decided by one:
 * Vision splices the TLS record layer and works only where the stream is the TLS
 * stream (RAW and XHTTP).
 *
 * `flow` DEFAULTS to `xtls-rprx-vision`, so moving an inbound to gRPC and not
 * thinking about flow left a server account demanding Vision while every client
 * link the panel emits answers without it (`core-adapters/xray/uri.ts` drops it
 * there): xray then rejects every client, "client flow is empty". Measured on
 * xray 26.3.27. xray refuses REALITY on ws/kcp outright, so gRPC is the case
 * this is really for; TLS on ws/httpupgrade/kcp is covered too.
 */
// The list is in @iceslab/shared, where the profile form reads it too.
export { NETWORKS_CARRYING_VISION };

/** Every field owned by some transport, i.e. the set we are allowed to drop. */
const ALL_TRANSPORT_FIELDS = [...new Set(Object.values(FIELDS_BY_NETWORK).flat())];

/**
 * Drop the transport settings that do not belong to `config.network`.
 *
 * Pure, and returns a new object only when something was actually removed or blanked, so an
 * unchanged profile keeps its object identity (and its stored JSON byte-stable).
 */
export function stripInapplicableTransportFields<T extends Record<string, unknown>>(
  config: T,
): T {
  // `tcp` is the pre-24.9.30 spelling of `raw` that old rows still carry.
  const named = typeof config.network === 'string' ? config.network : 'raw';
  const network = named === 'tcp' ? 'raw' : named;
  const keep = new Set(FIELDS_BY_NETWORK[network] ?? []);
  const drop = ALL_TRANSPORT_FIELDS.filter((f) => !keep.has(f) && f in config);
  // Blanked rather than deleted: '' is the canonical "no flow" wire value the
  // schema accepts, and unlike the transport settings the field is not optional.
  const blankFlow =
    !(NETWORKS_CARRYING_VISION as readonly string[]).includes(network) &&
    typeof config.flow === 'string' &&
    config.flow !== '';
  if (drop.length === 0 && !blankFlow) return config;
  const out: Record<string, unknown> = { ...config };
  for (const f of drop) delete out[f];
  if (blankFlow) out.flow = '';
  return out as T;
}
