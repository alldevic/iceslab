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
 * `flow` is not owned by a transport, but its VALIDITY is decided by one, so it
 * belongs to the same sweep: Vision splices the TLS record layer and works only
 * where the stream is the TLS stream (RAW and XHTTP).
 *
 * It survived a transport switch until now, and `flow` DEFAULTS to
 * `xtls-rprx-vision` - so moving an inbound to gRPC and not thinking about flow
 * left a server account demanding Vision while every client link the panel
 * emits answers without it. `core-adapters/xray/uri.ts` has always dropped it
 * for gRPC, so the default subscription format was already mismatched; the
 * node's own adapter records the resulting handshake failure, "client flow is
 * empty", from an earlier version of the same bug.
 *
 * gRPC is the case that matters: xray REFUSES a REALITY inbound on ws/kcp
 * outright (see `REALITY_TRANSPORTS` in inbounds.schemas.ts), so those never
 * ran to be mismatched. `grpc + Vision` loads happily and then rejects clients.
 */
const NETWORKS_CARRYING_VISION = new Set(['raw', 'xhttp']);

/** Every field owned by some transport, i.e. the set we are allowed to drop. */
const ALL_TRANSPORT_FIELDS = [...new Set(Object.values(FIELDS_BY_NETWORK).flat())];

/**
 * Drop the transport settings that do not belong to `config.network`.
 *
 * Pure, and returns a new object only when something was actually removed, so an
 * unchanged profile keeps its object identity (and its stored JSON byte-stable).
 */
export function stripInapplicableTransportFields<T extends Record<string, unknown>>(
  config: T,
): T {
  const network = typeof config.network === 'string' ? config.network : 'raw';
  const keep = new Set(FIELDS_BY_NETWORK[network] ?? []);
  const drop = ALL_TRANSPORT_FIELDS.filter((f) => !keep.has(f) && f in config);
  // Blanked rather than deleted: '' is the canonical "no flow" wire value the
  // schema already accepts, and the field is not optional the way the transport
  // settings are.
  const blankFlow =
    !NETWORKS_CARRYING_VISION.has(network) && !!config.flow && config.flow !== '';
  if (drop.length === 0 && !blankFlow) return config;
  const out = { ...config };
  for (const f of drop) delete out[f];
  if (blankFlow) (out as Record<string, unknown>).flow = '';
  return out;
}
