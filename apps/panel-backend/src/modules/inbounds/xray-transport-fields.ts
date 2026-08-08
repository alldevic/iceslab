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
  if (drop.length === 0) return config;
  const out = { ...config };
  for (const f of drop) delete out[f];
  return out;
}
