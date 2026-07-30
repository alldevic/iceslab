/**
 * Which Host fields actually mean anything for a given profile.
 *
 * The Host row carries TLS/transport overrides (`sniOverride`, `pathOverride`,
 * `fingerprintOverride`, `alpn`, ...) for every profile regardless of protocol,
 * but only a fraction of them ever reach the client. Verified 2026-07-29 by
 * reading the URI builders and every subscription formatter:
 *
 *   - `alpn` / `allowInsecure` / `securityLayer` are threaded onto every
 *     endpoint in subscription.service (`hostMeta`), but every formatter reads
 *     them ONLY inside its xray branch: clash.ts:298, xrayjson.ts:235,
 *     loon.ts:28, quantumultx.ts:24. The hysteria branch of loon.ts:24 emits
 *     host/port/password/obfs and nothing else.
 *   - `HysteriaUriOpts` / `NaiveUriOpts` / `ShadowsocksUriOpts` /
 *     `MtprotoUriOpts` / `MieruUriOpts` have no sni/alpn/fingerprint members at
 *     all, so those overrides cannot reach the wire. Hysteria emits `sni` but
 *     hardcodes it to the connect host (hysteria/uri.ts:46).
 *   - AmneziaWG ships a wg-quick config, not a URI: there is no TLS layer to
 *     override in the first place.
 *
 * So for six protocols out of seven, seven of the nine override fields are
 * dead controls. The form used to render them anyway, which is the same defect
 * class we removed from the routing screens: a control that silently does
 * nothing. This table is the single source both the form and the validator
 * read, so a new protocol is one entry here rather than a sweep across screens.
 *
 * Support depends on more than the protocol: for xray, `path` and `Host` exist
 * only on the HTTP-ish transports, and `fingerprint` only when a TLS-like
 * layer is present. That is why this resolves against the profile's config and
 * the endpoint hangs off a profile id rather than being a static lookup.
 */

/** Host columns an operator edits. Anything absent from a resolved map is not
 *  rendered by the form, so universal fields must be listed too. */
export type HostFieldName =
  | 'remark'
  | 'priority'
  | 'enabled'
  | 'addressOverride'
  | 'portOverride'
  | 'sniOverride'
  | 'hostHeaderOverride'
  | 'pathOverride'
  | 'fingerprintOverride'
  | 'alpn'
  | 'allowInsecure'
  | 'securityLayer'
  | 'disableForFormats';

export interface HostFieldSupport {
  /** False = the value cannot reach the client for this profile. The form
   *  omits the control entirely rather than disabling it: a disabled input
   *  still invites the question "what would go here". */
  supported: boolean;
  /** What the field falls back to when the host leaves it NULL. Rendered as a
   *  dim placeholder so the operator sees they are overriding, not filling in
   *  from scratch. Null = no profile-level default (adapter decides, or the
   *  value depends on the node rather than the profile). */
  inherited?: string | string[] | null;
  /** Why the field is unsupported, or why `inherited` is null when it looks
   *  like it should have a value. Shown as-is, so it is written for an
   *  operator, not a developer. */
  reason?: string;
}

export type HostFieldMap = Record<string, HostFieldSupport>;

/** Transports that carry an HTTP layer, so a path and a Host header exist.
 *  `grpc` is deliberately absent: it uses `serviceName` from the profile, and
 *  `raw`/`kcp` have no HTTP framing at all (inbounds.schemas.ts:134). */
const HTTP_TRANSPORTS = new Set(['ws', 'xhttp', 'httpupgrade']);

/** Always meaningful: they are panel-side bookkeeping or plain dial targets,
 *  and every protocol resolves them the same way (subscription.service.ts:365
 *  applies address/port overrides before the protocol switch). */
const UNIVERSAL: HostFieldName[] = [
  'remark',
  'priority',
  'enabled',
  'addressOverride',
  'portOverride',
  'disableForFormats',
];

/** Fields that exist only where a client-side TLS/transport layer does. */
const TLS_AND_TRANSPORT: HostFieldName[] = [
  'sniOverride',
  'hostHeaderOverride',
  'pathOverride',
  'fingerprintOverride',
  'alpn',
  'allowInsecure',
  'securityLayer',
];

function unsupported(fields: HostFieldName[], reason: string): HostFieldMap {
  const out: HostFieldMap = {};
  for (const f of fields) out[f] = { supported: false, reason };
  return out;
}

function universalMap(): HostFieldMap {
  const out: HostFieldMap = {};
  for (const f of UNIVERSAL) out[f] = { supported: true, inherited: null };
  return out;
}

interface XrayShape {
  security?: 'reality' | 'none' | 'tls';
  realityMode?: 'steal-others' | 'self-steal';
  realityServerNames?: string[];
  tlsServerName?: string;
  fingerprint?: string;
  network?: string;
  path?: string;
  host?: string;
}

function resolveXray(config: XrayShape): HostFieldMap {
  const security = config.security ?? 'reality';
  const network = config.network ?? 'raw';
  const isHttpish = HTTP_TRANSPORTS.has(network);
  const isSelfSteal = config.realityMode === 'self-steal';

  // SNI stays supported even when security is 'none'. A plain inbound fronted
  // by a CDN that terminates TLS is a real shape (that is what the host's
  // `securityLayer: 'tls'` exists for, see schema.prisma:199-203), and there
  // the SNI is the CDN's name. Marking it unsupported would break that setup.
  let sniInherited: string | null;
  let sniReason: string | undefined;
  if (isSelfSteal) {
    // B3/G: self-steal serves the NODE's own domain, so the inherited value is
    // per-node and cannot be resolved from the profile alone
    // (subscription.service.ts:441-442).
    sniInherited = null;
    sniReason = 'self-steal uses each node\'s own domain, so the inherited value differs per node';
  } else if (security === 'tls') {
    sniInherited = config.tlsServerName ?? null;
  } else if (security === 'reality') {
    sniInherited = config.realityServerNames?.[0] ?? null;
  } else {
    sniInherited = null;
    sniReason = 'this profile serves no TLS itself; set a value only when a CDN terminates TLS in front of it';
  }

  return {
    ...universalMap(),
    sniOverride: {
      supported: true,
      inherited: sniInherited,
      ...(sniReason ? { reason: sniReason } : {}),
    },
    fingerprintOverride: {
      supported: security !== 'none',
      inherited: security !== 'none' ? config.fingerprint ?? 'chrome' : null,
      ...(security === 'none'
        ? { reason: 'the client fakes a TLS fingerprint only when it speaks TLS' }
        : {}),
    },
    pathOverride: {
      supported: isHttpish,
      inherited: isHttpish ? config.path ?? '/' : null,
      ...(isHttpish ? {} : { reason: `the ${network} transport carries no path` }),
    },
    hostHeaderOverride: {
      supported: isHttpish,
      inherited: isHttpish ? config.host ?? null : null,
      ...(isHttpish ? {} : { reason: `the ${network} transport sends no Host header` }),
    },
    // No profile-level alpn field exists; the adapter picks a default per
    // transport, so there is nothing to inherit, only to set.
    alpn: { supported: true, inherited: null },
    allowInsecure: { supported: true, inherited: null },
    securityLayer: { supported: true, inherited: null },
  };
}

/**
 * Resolve the field map for one profile.
 *
 * `config` is `Profile.config` as stored (already merged with nothing: binding
 * overrides are per-node and deliberately not consulted here, the form edits a
 * host that hangs off one binding but the field SET is a property of the
 * profile).
 */
export function resolveHostFields(protocol: string, config: unknown): HostFieldMap {
  const cfg = (config ?? {}) as Record<string, unknown>;

  switch (protocol) {
    case 'xray':
      return resolveXray(cfg as XrayShape);

    case 'hysteria':
      return {
        ...universalMap(),
        ...unsupported(
          TLS_AND_TRANSPORT,
          'Hysteria2 negotiates its own TLS over QUIC and takes the SNI from the address it dials',
        ),
      };

    case 'naive':
      return {
        ...universalMap(),
        // Unlike every other protocol, naive has a profile-level default for
        // the dial address: Caddy answers ACME on `hostname`, so that is what
        // the client is handed unless the host overrides it.
        addressOverride: {
          supported: true,
          inherited: (cfg.hostname as string | undefined) ?? null,
        },
        ...unsupported(
          TLS_AND_TRANSPORT,
          'NaiveProxy serves a real certificate for the hostname in the profile and imitates Chromium, nothing here is client-tunable',
        ),
      };

    case 'shadowsocks':
      return {
        ...universalMap(),
        ...unsupported(TLS_AND_TRANSPORT, 'Shadowsocks has no TLS layer'),
      };

    case 'mtproto':
      return {
        ...universalMap(),
        ...unsupported(
          TLS_AND_TRANSPORT,
          'the masquerade domain is baked into each user secret, it is set on the profile and cannot vary per host',
        ),
      };

    case 'mieru':
      return {
        ...universalMap(),
        ...unsupported(TLS_AND_TRANSPORT, 'Mieru uses its own obfuscation, not TLS'),
      };

    case 'amneziawg':
      return {
        ...universalMap(),
        ...unsupported(
          TLS_AND_TRANSPORT,
          'AmneziaWG hands out a wg-quick config, there is no TLS layer to override',
        ),
      };

    default:
      // Unknown protocol: expose only what is protocol-agnostic rather than
      // guessing. Better a thin form than one promising controls that do
      // nothing.
      return universalMap();
  }
}

/**
 * Whether a host's SNI override is consistent with what the node will actually
 * serve. Returns null when there is nothing to check.
 *
 * REALITY completes the handshake only for a server name the inbound was
 * configured with, so an SNI outside `realityServerNames` produces a host that
 * looks healthy, hands out URLs and never connects. `hosts.schemas.ts:38`
 * accepts any string, which is how that state becomes reachable.
 *
 * The `securityLayer: 'tls'` case is deliberately exempt: there a CDN
 * terminates TLS in front of the inbound and the SNI is legitimately the CDN's
 * own name, unrelated to REALITY's list.
 */
export function checkSniConsistency(opts: {
  protocol: string;
  config: unknown;
  sniOverride: string | null | undefined;
  securityLayer: string | null | undefined;
}): { ok: false; expected: string[] } | null {
  const { protocol, sniOverride, securityLayer } = opts;
  if (protocol !== 'xray' || !sniOverride) return null;
  if (securityLayer === 'tls' || securityLayer === 'none') return null;

  const cfg = (opts.config ?? {}) as XrayShape;
  if ((cfg.security ?? 'reality') !== 'reality') return null;
  // Self-steal serves the node's own domain, which the profile does not know.
  if (cfg.realityMode === 'self-steal') return null;

  const names = cfg.realityServerNames ?? [];
  if (names.length === 0) return null;
  if (names.includes(sniOverride)) return null;
  return { ok: false, expected: names };
}
