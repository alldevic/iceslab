/**
 * The lists the profile API enforces and the profile form has to agree with.
 *
 * They live here, not in the backend, because the frontend tests (and the form
 * itself) need them and may not import backend sources: both sides import
 * these, so there is one list and no copy to drift. Number bounds are not
 * here; see CONTRIBUTING.md, "Mirror tests".
 */

/** Which engines each protocol may be served by. A protocol with one entry has
 *  a single core, and its form offers no choice. */
export const ENGINE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  xray: ['xray', 'singbox'],
  shadowsocks: ['xray', 'singbox'],
  hysteria: ['hysteria', 'singbox'],
  // sing-box is not one option among several for these three, it is the only
  // core that speaks them. Listing it anyway is what lets an operator SAY so:
  // without an entry here the protocol saves only with a null engine, and a
  // form that sends `engine: 'singbox'` is refused with a message about an
  // invalid engine, which reads as "this protocol is broken".
  tuic: ['singbox'],
  anytls: ['singbox'],
  shadowtls: ['singbox'],
  // MTProto: no engine is mtg, one secret for the inbound; mtprotoproxy gives
  // every user their own, revocable. mtg has no entry of its own: one state, one
  // record (decision 8.3).
  mtproto: ['mtprotoproxy'],
};

/**
 * The transports REALITY can carry, per xray itself:
 * `infra/conf: REALITY only supports RAW, XHTTP and gRPC for now.`
 */
export const REALITY_TRANSPORTS = ['raw', 'xhttp', 'grpc'] as const;

/** The transports Vision (`flow`) works on: where the stream is the TLS stream. */
export const NETWORKS_CARRYING_VISION = ['raw', 'xhttp'] as const;
