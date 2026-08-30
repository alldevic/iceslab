import { z } from 'zod';

const NameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(64, 'Name too long')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, underscore, hyphen');

const PortSchema = z.number().int().min(1).max(65535);

// ───── Per-protocol config schemas ─────

/**
 * U4 configurable anti-abuse, shared by every protocol whose core renders the
 * built-in BLOCK rules (xray and shadowsocks both emit an xray routing
 * section). One shape for both, so a toggle cannot mean two different things
 * depending on which core serves the profile.
 *
 * Each flag defaults to true, so a policy that IS present always travels the
 * wire fully specified and the operator only flips the rule they want to relax.
 * The wrapping `.optional()` (at each use site) is what keeps an untouched
 * profile byte-identical: no object at all, nothing on the wire, and the node
 * decodes nil and enables all three.
 */
const AbusePolicySchema = z.object({
  blockTorrent: z.boolean().default(true),
  blockSmtp: z.boolean().default(true),
  blockDnsHijack: z.boolean().default(true),
});

export const HysteriaConfigSchema = z.object({
  /**
   * Public FQDN hysteria issues its ACME (Let's Encrypt) certificate for. Not
   * something an admin fills in: the sync worker derives it from the node's
   * address, which is the name clients dial and validate. Present so a node
   * moved to a new address re-issues its certificate instead of needing a
   * re-install. Omitted when the address is an IP, leaving the node on its
   * install-time hostname.
   */
  hostname: z.string().max(253).optional(),
  /** Optional Salamander obfuscation password. Leave empty for no obfs. */
  obfsPassword: z.string().max(128).optional(),
  /** Local URL Hysteria masquerades to for non-authenticated probers. */
  masqueradeUrl: z.string().url().optional(),
  /** Brutal CC up bandwidth in Mbps (server hint). */
  brutalUpMbps: z.number().int().positive().max(10000).optional(),
  /** Brutal CC down bandwidth in Mbps. */
  brutalDownMbps: z.number().int().positive().max(10000).optional(),
  /**
   * Port-hopping range (slice 31.5). When set, clients rotate destination
   * UDP port within `[start, end]` on each connection. Defeats RU TSPU /
   * IR / CN UDP/443 throttle that targets a single fixed port. Server still
   * listens on a single port (typically :443/udp); install-iceslab-node.sh sets up
   * iptables to REDIRECT the configured range → listen port. The range in
   * the profile MUST be a subset of the range install-iceslab-node.sh applied,
   * otherwise the redirect won't catch the rotating ports.
   *
   * Both fields must be set together (or both empty) and `end > start`.
   * That used to be enforced in `inbounds.service.ts`, and the sentence
   * outlived the file: slice 27 removed the inbound routes and their service
   * with them, so from then until 2026-08-29 nothing checked it. Measured
   * against the live panel, all three accepted with a 201:
   *
   *   {start: 50000, end: 20000}   an inverted range
   *   {start: 30000}               half a pair
   *   {start: 1100, end: 1200}     a range no node redirects
   *
   * Half a pair is the quiet one: `buildHysteriaUri` emits `mport=` only when
   * BOTH are numbers, so the operator turns port-hopping on, the panel says
   * 201, and every client link goes out without it.
   *
   * Refined here rather than in a service, because a service is a place a
   * request can arrive without passing through. This is the same superRefine
   * the xray and AmneziaWG schemas below already carry, and it is safe for the
   * reason stated there: the discriminated unions key off the top-level
   * `protocol` literal, not off this `config` member.
   */
  portHoppingStart: z.number().int().min(1024).max(65535).optional(),
  portHoppingEnd: z.number().int().min(1024).max(65535).optional(),
})
  .superRefine((cfg, ctx) => {
    const start = cfg.portHoppingStart;
    const end = cfg.portHoppingEnd;
    if ((start === undefined) !== (end === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [start === undefined ? 'portHoppingStart' : 'portHoppingEnd'],
        message:
          'port-hopping needs both ends of the range: with only one, the client link carries no mport= at all and the feature is silently off',
      });
      return;
    }
    if (start !== undefined && end !== undefined && end <= start) {
      ctx.addIssue({
        code: 'custom',
        path: ['portHoppingEnd'],
        message: `port-hopping range must end above where it starts (got ${start}-${end})`,
      });
    }
  });

/**
 * Which half of an `xray vlessenc` pair a string is, read off xray's own
 * grammar rather than off the wording around it (infra/conf/vless.go, mirrored
 * verbatim in mihomo's transport/vless/encryption/factory.go): the third
 * dot-separated part is a handshake mode on the CLIENT half (`1rtt` / `0rtt`)
 * and a ticket lifetime on the SERVER half (`600s`, `600-900s`).
 *
 * Unknown is a real answer, not a failure: this exists to catch the two halves
 * swapped, which yields a profile nobody can connect to, and a shape no
 * released xray prints today must still pass through rather than be rejected on
 * a guess about the future.
 */
export function vlessEncryptionHalf(s: string): 'client' | 'server' | 'unknown' {
  const parts = s.split('.');
  if (parts.length < 4 || parts[0] !== 'mlkem768x25519plus') return 'unknown';
  if (parts[2] === '1rtt' || parts[2] === '0rtt') return 'client';
  if (/^\d+(-\d+)?s$/.test(parts[2])) return 'server';
  return 'unknown';
}

/**
 * Which authentication a VLESS-Encryption string carries, again read off xray's
 * own parser: the key parts (dot-separated, 20 chars or longer - shorter ones
 * are a padding spec) are 32 bytes for X25519 and 64 / 1184 bytes for the
 * ML-KEM-768 server seed / client encapsulation key.
 *
 * `xray vlessenc` prints BOTH authentications in one run and says "do not mix
 * them", so this is what tells the post-quantum pair from the classical one -
 * and what catches a profile holding one half of each, which no length or shape
 * check would.
 */
export function vlessEncryptionAuth(s: string): 'x25519' | 'mlkem768' | 'unknown' {
  const half = vlessEncryptionHalf(s);
  if (half === 'unknown') return 'unknown';
  const pqLen = half === 'server' ? 64 : 1184;
  let sawClassic = false;
  for (const part of s.split('.').slice(3)) {
    if (part.length < 20) continue;
    const len = Buffer.from(part, 'base64').length;
    if (len === pqLen) return 'mlkem768';
    if (len === 32) sawClassic = true;
  }
  return sawClassic ? 'x25519' : 'unknown';
}

/**
 * An X25519 key as REALITY spells it: base64url of 32 bytes, unpadded, so
 * exactly 43 characters out of [A-Za-z0-9_-].
 *
 * This is NOT the WireGuard alphabet, and that is the whole point of checking.
 * xray decodes both `privateKey` and the client's `publicKey` with
 * base64.RawURLEncoding and refuses anything else
 * (infra/conf/transport_security.go), so a standard-base64 key - the kind with
 * `+`, `/` and `=` in it - takes the profile down completely: xray rejects the
 * config, the node keeps the last good one, and the only place that says why is
 * the node's journal. The panel logs "1/1 inbounds failed to apply" and the
 * operator gets to guess. Seen for real on 2026-08-24, from a keypair generated
 * for the wrong protocol.
 *
 * Empty stays legal: it is the "not configured yet" state the form starts in.
 */
const RealityKeySchema = z
  .string()
  .max(128)
  .refine(
    (v) => v === '' || /^[A-Za-z0-9_-]{43}$/.test(v),
    'must be a base64url X25519 key: 43 chars from [A-Za-z0-9_-], no + / or = (that alphabet is WireGuard\'s, and xray rejects it)',
  )
  .default('');

/**
 * The transports REALITY can carry, per xray itself:
 * `infra/conf: REALITY only supports RAW, XHTTP and gRPC for now.`
 */
const REALITY_TRANSPORTS = new Set(['raw', 'xhttp', 'grpc']);

export const XrayConfigSchema = z.object({
  /**
   * Stream security. 'reality' (default) or 'none' (plain transport, e.g.
   * ws/httpupgrade behind a CDN that terminates TLS, or local testing). The
   * reality* fields below are required only for 'reality' (the form enforces
   * that client-side and the node's config.go validate() rejects a reality
   * inbound with missing keys). Kept as a plain ZodObject (no .refine) so it
   * participates in the InboundConfigByProtocol discriminated union.
   */
  security: z.enum(['reality', 'none', 'tls']).default('reality'),
  /** TLS (security='tls'): SNI the node serves + operator-supplied PEM cert
   *  chain and private key (embedded inline in the xray config; no ACME). The
   *  node's config.go validate() requires cert+key when security is 'tls'. */
  tlsServerName: z.string().max(253).optional(),
  tlsCert: z.string().max(16384).optional(),
  tlsKey: z.string().max(16384).optional(),
  /** Reject TLS handshakes whose SNI does not match a served server name.
   *  Hardens against probing; off by default to stay lenient for plain probes. */
  tlsRejectUnknownSni: z.boolean().default(false),
  /**
   * REALITY target: the legitimate site Xray forwards mismatched probes to.
   * Format `host:port`, e.g. "www.cloudflare.com:443". May be empty when
   * security is 'none'.
   */
  realityDest: z.string().regex(/^[a-zA-Z0-9.-]+:\d{1,5}$/).or(z.literal('')).default(''),
  /**
   * REALITY masquerade names.
   *
   * Cap raised 8 -> 32 on 2026-08-10. The old number was a guess at what anyone
   * would need; a migration audit of an incoming panel found inbounds carrying
   * 21 names, so the guess was about to cost that operator either a failed
   * import or a silently shortened masquerade list. 32 is still a bound on
   * accidents (a paste of a whole domain list), not on legitimate use - xray
   * itself sets no limit here.
   */
  realityServerNames: z.array(z.string().min(1).max(255)).max(32).default([]),
  /** REALITY shortIds: hex strings, max 16 chars each. */
  realityShortIds: z
    .array(z.string().regex(/^[0-9a-fA-F]{0,16}$/))
    .max(8)
    .default([]),
  realityPrivateKey: RealityKeySchema,
  /** REALITY public key paired with privateKey, emitted in client URI. */
  realityPublicKey: RealityKeySchema,
  /** REALITY protocol version mirrored to the upstream TLS dest. 0 (default)
   *  is the conservative choice; 1/2 enable newer REALITY handshake variants. */
  realityXver: z.number().int().min(0).max(2).default(0),
  /** Max clock skew (ms) REALITY tolerates between client and node. 0 (default)
   *  leaves it at xray-core's built-in value; raise it for clients with drift. */
  realityMaxTimeDiff: z.number().int().min(0).max(600000).default(0),
  /**
   * U5 post-quantum: server ML-DSA-65 seed (`xray mldsa65`) that adds an extra
   * post-quantum signature to the REALITY certificate. Optional (no default):
   * absent → omitted from the wire, node renders REALITY without it (byte-
   * identical to pre-U5). Opaque base64-ish string.
   *
   * THE TARGET MATTERS, and the rule is narrower than "big enough". REALITY
   * does not serve the target's certificate: it forges its own and writes the
   * ML-DSA-65 signature into a fixed 3309-byte extension slot (XTLS/REALITY
   * handshake_server_tls13.go), which makes the forged EncryptedExtensions
   * record about 3.6 KB.
   *
   * It only commits to matching the target's record length when that length is
   * over 512 bytes (`if i == 2 && handshakeLen > 512` in XTLS/REALITY tls.go);
   * below that it records nothing and pads nothing. So the fatal window is a
   * target whose EncryptedExtensions record is BETWEEN 512 bytes and the size
   * of the forged handshake: REALITY has promised to match a length its own
   * post-quantum record overflows. Measured on xray 26.3.27, 2026-08-24:
   * `www.cloudflare.com:443` (EE record 2043) dies 1614 bytes short of it,
   * while `www.amazon.com:443` (EE record 41) is never constrained and works.
   * A very large target is fine again for the same reason.
   *
   * The failure is invisible from here and nearly invisible on the node: the
   * agent logs `REALITY ... hs.handshake() err: payload[0]: 8, padding: -N`
   * and "handshake did not complete successfully", the client just retries,
   * and nothing anywhere names the target as the cause. Not guarded here: the
   * quantity is a property of the live target's TLS response, so the only
   * honest check dials it and measures, which is a feature with a network call
   * in it rather than a validator.
   */
  realityMldsa65Seed: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9+/=_-]*$/, 'must be a base64-ish ML-DSA-65 seed')
    .optional(),
  /**
   * U5 post-quantum, CLIENT half of `xray mldsa65`: the verify key, emitted as
   * `pqv=` in the share link and as `realitySettings.mldsa65Verify` in a full
   * config.
   *
   * Its absence does not break the connection, which is precisely why it needs
   * a guard rather than trust. xray checks the extra signature only when the
   * client holds a verify key, and otherwise takes the classical branch and
   * marks the connection verified (transport/internet/reality/reality.go,
   * VerifyPeerCertificate). A seed without a verify key is therefore a profile
   * that advertises post-quantum REALITY and delivers classical REALITY, with
   * nothing anywhere saying so.
   *
   * The length is fixed by the algorithm - an ML-DSA-65 public key is 1952
   * bytes and xray rejects any other length outright - so a truncated paste is
   * worth catching at save time instead of at push time.
   */
  realityMldsa65Verify: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9+/=_-]*$/, 'must be a base64-ish ML-DSA-65 verify key')
    .refine(
      (v) => Buffer.from(v, 'base64').length === 1952,
      'must decode to a 1952-byte ML-DSA-65 verify key',
    )
    .optional(),
  /**
   * U5 post-quantum: server-side VLESS-Encryption string (ML-KEM-768 native
   * encryption with PFS), e.g. "mlkem768x25519plus.native.600s.…", from
   * `xray vlessenc`. Optional (no default): absent → VLESS decryption renders as
   * "none" (byte-identical to pre-U5). Only the vless subprotocol uses it.
   */
  vlessDecryption: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9._-]*$/, 'must be a VLESS-Encryption string (mlkem768x25519plus.…)')
    .optional(),
  /**
   * U5 post-quantum, CLIENT half of the same `xray vlessenc` pair: it rides the
   * share link as `encryption=` and a full client config as the VLESS user's
   * `encryption` (xray builds the outbound account from it in
   * infra/conf/vless.go; Clash Meta parses the same grammar).
   *
   * Required whenever the server half is set, and the reverse: an inbound whose
   * `decryption` is set demands an ML-KEM handshake, and a client still sending
   * the pre-U5 `encryption=none` is refused, not degraded. Half a pair is a
   * profile nobody can connect to - see the superRefine at the bottom.
   */
  vlessEncryption: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9._-]*$/, 'must be a VLESS-Encryption string (mlkem768x25519plus.…)')
    .optional(),
  /** G - rate-limit unverified REALITY fallback connections, bytes/sec, 0 = off.
   *  Probe resistance: a scanner that fails REALITY auth is forwarded to the
   *  target throttled, so it sees a slow site instead of a full-speed proxy. */
  realityLimitFallbackUploadBytesPerSec: z.number().int().min(0).default(0),
  realityLimitFallbackDownloadBytesPerSec: z.number().int().min(0).default(0),
  /**
   * REALITY camouflage mode.
   *   - 'steal-others' (default): borrow an external site's TLS identity
   *     (realityDest points at a public host, e.g. a CDN).
   *   - 'self-steal': the node serves a local TLS fallback for its OWN domain;
   *     serverNames is overridden per-node with Node.domain at deploy time
   *     (see inbounds.queue + subscription.service).
   * MUST be declared here: Zod strips unknown keys, so without this field the
   * value is silently dropped when a profile is created/updated, the queue's
   * self-steal detection never fires, and the mode degrades to steal-others
   * (SNI != node IP -> RU-DPI mismatch). The wire DTO, node adapter, queue and
   * subscription all already read it; the schema was the missing link.
   */
  realityMode: z.enum(['steal-others', 'self-steal']).default('steal-others'),
  /** G1 realistic fallback (probe resistance). When set and realityMode is
   *  'self-steal', the node's local TLS fallback reverse-proxies probe requests
   *  to this real site instead of a stub page, so a deep prober sees genuine
   *  content. Empty = static landing page (the default). http(s) URL. */
  realityFallbackUpstream: z.string().url().max(512).or(z.literal('')).default(''),
  // Mantine Select returns null when the empty option is picked. Coerce to
  // '' so the schema accepts the "no flow" choice the same way it accepts
  // 'xtls-rprx-vision'. Empty string is the canonical "no flow" wire value.
  flow: z
    .union([z.string(), z.null()])
    .transform((v) => v ?? '')
    .pipe(z.string().max(64))
    .default('xtls-rprx-vision'),
  fingerprint: z.string().max(32).default('chrome'),
  /**
   * Stream transport. v24.9.30 names: `raw` (was `tcp`), `xhttp` (was
   * `splithttp`). REALITY+Vision canonical is `raw`. `ws`/`grpc`/`xhttp` work
   * but Vision is incompatible with `ws`/`grpc`, the adapter doesn't enforce
   * this at write time, the operator must align flow + network themselves.
   *
   * Slice 24c part 2 added `httpupgrade` (CDN-friendly, no WebSocket
   * handshake overhead) and `kcp` (UDP-based, useful on lossy networks).
   * `kcp` collides with Hysteria on the same UDP port, admin must avoid
   * port overlap manually (the panel doesn't cross-validate today).
   */
  network: z.enum(['raw', 'xhttp', 'ws', 'grpc', 'httpupgrade', 'kcp']).default('raw'),
  /** Path for `ws`, `xhttp`, `httpupgrade`. Default `/`. Ignored for `raw`/`grpc`/`kcp`. */
  path: z.string().max(255).optional(),
  /** Host header override for `ws`/`xhttp`/`httpupgrade`. Empty → use connect host. */
  host: z.string().max(255).optional(),
  /** gRPC serviceName. Required when network=grpc. */
  serviceName: z.string().max(64).optional(),
  /** XHTTP packet mode. 'auto' (default) lets xray pick; 'packet-up' /
   *  'stream-up' / 'stream-one' force a specific framing for tricky CDNs. */
  xhttpMode: z.enum(['auto', 'packet-up', 'stream-up', 'stream-one']).default('auto'),
  /** XHTTP request-padding byte range (e.g. "100-1000"). Empty disables
   *  padding; padding helps blur the packet-size signature under DPI. */
  xhttpPaddingBytes: z.string().max(32).default(''),
  /** gRPC multiMode. false (default) is single-stream; true multiplexes
   *  several gRPC streams per connection for better throughput. */
  grpcMultiMode: z.boolean().default(false),

  /**
   * Subprotocol carried over the same Xray binary + REALITY stack. Slice
   * 24c part 3:
   *   - `vless`   - canonical: per-user UUID, optional Vision flow
   *   - `trojan`  - per-user password (we reuse `user.xrayUuid` as the
   *                 password, UUID is high-entropy random and admins are
   *                 already managing it). No Vision flow on Trojan.
   * Same REALITY private/public key pair drives both, clients see the
   * difference only at the URI scheme level (`vless://` vs `trojan://`).
   *
   * Shadowsocks (SS2022) is deferred to a follow-up, multi-user model
   * differs (per-user keys + cipher selection) and benefits from its own
   * commit.
   */
  subprotocol: z.enum(['vless', 'trojan', 'vmess']).default('vless'),

  /**
   * U4 configurable anti-abuse. Gates the node's built-in xray routing BLOCK
   * rules (BitTorrent, SMTP port 25) and the DNS-hijack protection rule.
   *
   * Optional WITHOUT a top-level default on purpose: when omitted the parsed
   * config carries no `abusePolicy`, nothing is sent on the wire, the node's
   * adapter decodes nil, and renderConfig enables all three rules — byte-
   * identical to the pre-U4 hardcoded behaviour (so existing profiles are
   * untouched). When the object IS present, each flag defaults to true, so the
   * wire always carries a fully-specified policy and the operator only has to
   * flip the rule(s) they want to relax (e.g. blockTorrent:false on a
   * residential exit).
   */
  abusePolicy: AbusePolicySchema.optional(),
})
  /**
   * U5: post-quantum material comes in pairs, and half a pair is never what the
   * operator meant. Refining here is safe for the same reason it is safe on
   * AmneziawgConfigSchema below: the discriminated unions this schema feeds key
   * off the top-level `protocol` literal, not off this `config` member.
   */
  .superRefine((cfg, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    // REALITY carries only three transports, and xray refuses the config
    // outright for the rest - measured on 26.3.27, not inferred:
    //   raw   + Vision  -> loads      grpc + Vision -> loads
    //   xhttp + Vision  -> loads      ws / kcp      -> `infra/conf: REALITY
    //                                  only supports RAW, XHTTP and gRPC for now.`
    //
    // Refused at save because of what saving it did. Bound to a live node, the
    // agent wrote the config, xray exited 23, and the agent logged
    // `xray (re)started` and `addUser ok` at INFO on the way into a restart
    // loop - 17 crashes in the minute it took to look. The panel does notice
    // (`degraded`, `not running: xray`, a crash counter), so this is not a
    // silent failure; but the reason stays in the node's journal, nothing ties
    // it back to the profile just saved, and xray is ONE process per node, so
    // every other inbound on that node goes down with it.
    //
    // The constraint was already known here - `panel-frontend/src/lib/recipes.ts`
    // names REALITY+ws as its canonical example of a combo that "looks fine in
    // the form, dies on `xray run`". Recipes steered around it; the form let it
    // through. This is the same check, where it cannot be walked past.
    if (cfg.security === 'reality' && !REALITY_TRANSPORTS.has(cfg.network)) {
      issue(
        'network',
        `REALITY carries only ${[...REALITY_TRANSPORTS].join(', ')}: xray refuses to load a ${cfg.network} inbound with REALITY and the node's core restart-loops, taking every other inbound on it down too`,
      );
    }

    // The asymmetry between the two pairs is the point. A missing client half
    // of VLESS-Encryption breaks every connection to the profile the moment it
    // is saved; a missing verify key breaks nothing and quietly removes the
    // feature. Both are refused, because "enabled and doing nothing" is the
    // failure mode this fork keeps finding.
    if (cfg.vlessDecryption && !cfg.vlessEncryption) {
      issue(
        'vlessEncryption',
        'VLESS-Encryption needs its client half: the inbound would demand an ML-KEM handshake and every client link the panel emits answers with encryption=none',
      );
    }
    if (cfg.vlessEncryption && !cfg.vlessDecryption) {
      issue(
        'vlessDecryption',
        'VLESS-Encryption needs its server half: clients would encrypt to an inbound that decrypts nothing',
      );
    }
    if (cfg.vlessDecryption && vlessEncryptionHalf(cfg.vlessDecryption) === 'client') {
      issue(
        'vlessDecryption',
        'this is the client half (third part is a handshake mode, 1rtt/0rtt); the server half carries a ticket lifetime, e.g. 600s',
      );
    }
    if (cfg.vlessEncryption && vlessEncryptionHalf(cfg.vlessEncryption) === 'server') {
      issue(
        'vlessEncryption',
        'this is the server half (third part is a ticket lifetime, e.g. 600s); the client half carries a handshake mode, 1rtt/0rtt',
      );
    }
    // One half from each of the two authentications `xray vlessenc` prints in a
    // single run. Both halves are well-formed and the shapes agree; the key
    // material simply does not, and the handshake fails with nothing to read.
    if (cfg.vlessDecryption && cfg.vlessEncryption) {
      const server = vlessEncryptionAuth(cfg.vlessDecryption);
      const client = vlessEncryptionAuth(cfg.vlessEncryption);
      if (server !== 'unknown' && client !== 'unknown' && server !== client) {
        issue(
          'vlessEncryption',
          `the two halves are from different authentications (server: ${server}, client: ${client}) - "xray vlessenc" prints both in one run and they cannot be mixed`,
        );
      }
    }
    if (cfg.realityMldsa65Seed && !cfg.realityMldsa65Verify) {
      issue(
        'realityMldsa65Verify',
        'post-quantum REALITY needs its verify key: without it clients take the classical branch and the extra signature is never checked',
      );
    }
    if (cfg.realityMldsa65Verify && !cfg.realityMldsa65Seed) {
      issue(
        'realityMldsa65Seed',
        'post-quantum REALITY needs its server seed: clients would demand a signature the node never puts in the certificate',
      );
    }
  });

// Bounds and defaults match upstream amnezia-vpn AmneziaWG v2.0 spec
// (docs.amnezia.org/documentation/amnezia-wg). Old TSPU presets from
// v1.5 era (Jmin=40, S1=72) are out of v2.0's accepted ranges and
// caused silent handshake failures with the current DKMS module
// (1.0.20251009, already v2.0-capable). Caught live cycle #6
// 2026-05-13 after reading upstream docs.
//   - Jc: junk-packet count before handshake init     (0..10)
//   - Jmin/Jmax: junk-packet size range               (64..1024)
//   - S1/S2/S3: init/response/cookie padding bytes    (0..64)
//   - S4: data packet padding bytes                    (0..32)
//   - H1-H4: dynamic header bytes replacing WG type marker 1..4
//   - I1-I5: optional "mimicry" signature packets sent ahead of
//     handshake to disguise the flow as QUIC/DNS/etc. Hex strings;
//     empty disables the I-channel for that slot.
const ObfuscationSchema = z.object({
  jc: z.number().int().min(0).max(10).default(4),
  jmin: z.number().int().min(64).max(1024).default(64),
  jmax: z.number().int().min(64).max(1024).default(128),
  s1: z.number().int().min(0).max(64).default(32),
  s2: z.number().int().min(0).max(64).default(56),
  s3: z.number().int().min(0).max(64).default(32),
  s4: z.number().int().min(0).max(32).default(16),
  // H1-H4 replace the WG message-type marker; the node's config.go validate()
  // requires each > 4, pairwise distinct, and fitting a uint32. The cross-field
  // distinctness check lives in AmneziawgConfigSchema's superRefine below.
  h1: z.number().int().min(5).max(4294967295).default(100),
  h2: z.number().int().min(5).max(4294967295).default(200),
  h3: z.number().int().min(5).max(4294967295).default(300),
  h4: z.number().int().min(5).max(4294967295).default(400),
  // Mimicry packets: optional, v2.0 feature. When empty the kernel module skips
  // that slot. A value is either plain hex, or a 2.0 CPS signature built from
  // the tags `<b 0xHEX>` / `<r N>` / `<t>` (e.g. `<b 0xc00000000108><r 64><t>`,
  // a QUIC-Initial lookalike). The character set MUST match validateIField in
  // the node's amneziawg/config.go, otherwise a value saved here is refused on
  // the node and the inbound silently fails to apply. The set cannot form a
  // newline, '[', '=' or a shell metacharacter, so the INI/PostUp injection
  // guard still holds. Up to 256 chars per upstream guidance.
  i1: z.string().regex(/^[0-9a-fA-FxX<> rt]*$/).max(256).default(''),
  i2: z.string().regex(/^[0-9a-fA-FxX<> rt]*$/).max(256).default(''),
  i3: z.string().regex(/^[0-9a-fA-FxX<> rt]*$/).max(256).default(''),
  i4: z.string().regex(/^[0-9a-fA-FxX<> rt]*$/).max(256).default(''),
  i5: z.string().regex(/^[0-9a-fA-FxX<> rt]*$/).max(256).default(''),
});

/**
 * A WireGuard key, as the NODE defines one.
 *
 * `validateWGKey` in apps/node/internal/core/amneziawg/config.go: 44 base64
 * characters decoding to exactly 32 bytes. Its comment explains what the
 * whitelist is for, and it is not tidiness — a pre-wave panel pushed the public
 * key into an awg-quick INI with `fmt.Fprintf` and no validation, so a `\n` in
 * the value closed `[Peer]` and opened `[Interface]` with a `PostUp=sh -c ...`
 * of the sender's choosing: root on every interface bring-up.
 *
 * The panel accepted `z.string().min(1).max(128)` — a newline, a quote, a
 * semicolon, anything under 128 characters. The node held, which is why this is
 * defence in depth rather than a hole; what the panel lost was the OTHER half:
 * a mistyped key was stored, pushed, and refused by the node, and the operator
 * saw "config push failed" instead of a message on the field.
 *
 * Written as a regex rather than a decode-and-measure because 32 bytes is
 * exactly 43 base64 characters plus one `=`, and because the alphabet is the
 * guard: it cannot express a newline or a shell metacharacter.
 */
const WgKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{43}=$/,
    'WireGuard key must be 44 base64 characters (a 32-byte key), as `wg genkey` emits',
  );

export const AmneziawgConfigSchema = z
  .object({
    /** Subnet handed to peers, e.g. "10.0.0.0/24". */
    subnet: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/),
    serverPrivateKey: WgKeySchema,
    /** Public key paired with privateKey, emitted in client config. */
    serverPublicKey: WgKeySchema,
    obfuscation: ObfuscationSchema,
  })
  // Mirror the constraints the node's config.go validate() enforces at deploy
  // time, so the operator gets a clear form error instead of a confusing
  // "config push failed" after save. Refining this nested ZodObject is safe:
  // the InboundConfigByProtocol discriminated union keys off the top-level
  // `protocol` literal, not off this `config` member, so the refinement does
  // not interfere with discrimination.
  .superRefine((cfg, ctx) => {
    const { obfuscation } = cfg;
    // H1-H4 must be pairwise distinct (a repeated header value collapses two
    // packet types onto the same marker and breaks the obfuscation).
    const headers: Array<['h1' | 'h2' | 'h3' | 'h4', number]> = [
      ['h1', obfuscation.h1],
      ['h2', obfuscation.h2],
      ['h3', obfuscation.h3],
      ['h4', obfuscation.h4],
    ];
    for (let i = 0; i < headers.length; i++) {
      for (let j = i + 1; j < headers.length; j++) {
        if (headers[i][1] === headers[j][1]) {
          ctx.addIssue({
            code: 'custom',
            message: `H1-H4 must be pairwise distinct (${headers[i][0]} equals ${headers[j][0]})`,
            path: ['obfuscation', headers[j][0]],
          });
        }
      }
    }
    // Jmin <= Jmax. The node refuses the inverted pair at deploy time
    // ("Jmin (%d) must be <= Jmax (%d)"), and this mirror existed for every
    // other rule in its validate() except this one — so the one shape an
    // operator can reach with two steppers was the one that saved cleanly and
    // failed at the push, which is the outcome the comment above says this
    // block exists to prevent.
    if (obfuscation.jmin > obfuscation.jmax) {
      ctx.addIssue({
        code: 'custom',
        message: `Jmin (${obfuscation.jmin}) must be <= Jmax (${obfuscation.jmax})`,
        path: ['obfuscation', 'jmax'],
      });
    }
    // s1 + 56 must NOT equal s2: that recreates the vanilla WireGuard handshake
    // packet length and makes the flow DPI-detectable.
    if (obfuscation.s1 + 56 === obfuscation.s2) {
      ctx.addIssue({
        code: 'custom',
        message: 's1 + 56 must not equal s2 (recreates the vanilla WireGuard handshake length, making the flow detectable)',
        path: ['obfuscation', 's2'],
      });
    }
  });

/**
 * Upstream WireGuard: the same interface the AmneziaWG adapter manages, minus
 * every obfuscation knob. There is deliberately no `obfuscation` member, and
 * not an all-zero one: WireGuard's magic headers are fixed at 1..4 and its
 * handshake carries no junk, so anything configurable here would be a field
 * the node can only ignore. That also keeps the two protocols honestly
 * distinct in the UI - a "WireGuard" inbound is plainly detectable as
 * WireGuard, which is the whole point of offering it (native clients, no
 * AmneziaWG-aware app required).
 */
export const WireguardConfigSchema = z.object({
  /** Subnet handed to peers, e.g. "10.77.77.0/24". Keep it clear of the
   *  AmneziaWG profile's subnet when a node serves both. */
  subnet: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/),
  serverPrivateKey: WgKeySchema,
  /** Public key paired with privateKey, emitted in the client config. */
  serverPublicKey: WgKeySchema,
});

export const NaiveConfigSchema = z.object({
  hostname: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9.-]+$/, 'No spaces / scheme, hostname only'),
  tlsEmail: z.string().email(),
  masqueradeRoot: z.string().min(1).max(255).default('/var/www/html'),
});

/**
 * Shadowsocks 2022 ciphers we expose. Slice 24d.
 *
 * Why a curated list rather than free-text:
 *   - SS2022 ciphers (`2022-blake3-aes-...`) require Xray ≥ v1.8 and use a
 *     pre-shared key model that's incompatible with the legacy AEAD
 *     ciphers, clients fail silently if mismatched.
 *   - Legacy AEAD (`chacha20-ietf-poly1305`, `aes-256-gcm`) work with every
 *     SS client back to ~2018, but are increasingly fingerprintable. We
 *     keep them for compat with old client builds.
 *   - Other ciphers (AES-CFB, RC4-MD5, etc) are insecure, explicitly
 *     omitted from the enum to prevent admin misconfiguration.
 */
export const ShadowsocksMethodSchema = z.enum([
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'chacha20-ietf-poly1305',
  'aes-256-gcm',
  'aes-128-gcm',
]);

export const ShadowsocksConfigSchema = z.object({
  /** Cipher method. SS2022 (`2022-blake3-*`) recommended for new deployments. */
  method: ShadowsocksMethodSchema.default('2022-blake3-aes-256-gcm'),

  /**
   * Server PSK: required by xray-core SS2022 at the `settings.password`
   * level. SS2022 multi-user model uses ServerPSK for the inbound itself
   * plus per-user PSK (per `clients[]` entry); clients connect with
   * `base64url(method:ServerPSK:UserPSK)` joined.
   *
   * For SS2022 ciphers the PSK MUST match the cipher's key length
   * (16 bytes for `2022-blake3-aes-128-gcm`, 32 bytes for the others)
   * encoded as base64. Auto-generated on inbound create when empty.
   *
   * Verified against XTLS/Xray-examples Shadowsocks-2022/README on
   * 2026-05-07: server-side `clients[]` requires `settings.password`.
   */
  serverPsk: z.string().min(1).max(128).optional(),

  /**
   * U4 configurable anti-abuse. The shadowsocks core renders the same BLOCK
   * rules as the xray core (it runs an xray process too), so it takes the same
   * policy. Absent = all three enabled, byte-identical to pre-U4.
   */
  abusePolicy: AbusePolicySchema.optional(),
});

/**
 * MTProto Telegram-proxy config (slice 41). Uses `9seconds/mtg` server.
 *
 * Single tunable today: `domain`, the legitimate site mtg masquerades
 * as during Fake-TLS handshake. Any reachable, plausible site works
 * (`www.cloudflare.com`, `www.google.com`, etc). Changing domain rotates
 * every user's secret because the domain is hex-baked into each per-user
 * secret string, UI must warn before save.
 */
export const MtprotoConfigSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, 'Hostname only (no scheme, no path)')
    .default('www.cloudflare.com'),
});

/**
 * Mieru stealth-proxy config (slice 40). Uses `enfein/mieru` server (`mita`).
 *
 * MTU is the only commonly-tuned knob. Default 1400 leaves headroom on
 * most paths; admins on PPPoE / weird VPNs may drop to 1280.
 *
 * The floor is 1280 because that is what the NODE enforces - mieru/config.go's
 * validate() refuses anything below it, citing upstream's operation.md. This
 * schema said 576, so the panel accepted 576..1279 with a 201 and the node then
 * refused the config: the operator got "1/1 inbounds failed to apply" and no
 * message on any field, for a value the panel had just told them was fine. The
 * prose right above already said 1280; only the number disagreed.
 *
 * mieru-mtu-bounds.test.ts reads the range out of the node's source rather than
 * restating it, so the pair cannot drift apart again in silence.
 */
export const MieruConfigSchema = z.object({
  mtu: z.number().int().min(1280).max(1500).default(1400),
});

/**
 * TUIC v5 config (sing-box engine, slice singbox-S2). `serverName` is the TLS
 * SNI the node's self-signed cert is issued for; the client connects with it
 * (+ allow-insecure for the alpha). `congestionControl` tunes the QUIC sender.
 */
export const TuicConfigSchema = z.object({
  serverName: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, 'Hostname only (no scheme, no path)')
    .default('www.bing.com'),
  congestionControl: z.enum(['bbr', 'cubic', 'new_reno']).default('bbr'),
});

/**
 * AnyTLS config (sing-box engine). TCP+TLS, password-only (the password lives
 * on the user, derived from xrayUuid). serverName = TLS SNI for the node's
 * self-signed cert; client connects with it (+ allow-insecure in the alpha).
 */
export const AnytlsConfigSchema = z.object({
  serverName: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, 'Hostname only (no scheme, no path)')
    .default('www.bing.com'),
});

/**
 * ShadowTLS v3 config (sing-box engine). TLS-camouflage wrapper: fronts a real
 * handshake to `handshake` (a whitelisted site) and detours to an inner single-key
 * shadowsocks. Per-user auth is the shadowtls password (derived from xrayUuid).
 * `ssPassword` is the inner ss server key - auto-generated on inbound create,
 * valid base64 of the cipher's key length (like Shadowsocks serverPsk).
 */
export const ShadowtlsConfigSchema = z.object({
  handshake: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, 'Hostname only (no scheme, no path)')
    .default('www.microsoft.com'),
  ssMethod: ShadowsocksMethodSchema.default('2022-blake3-aes-128-gcm'),
  ssPassword: z.string().min(1).max(128).optional(),
});

// Discriminated union over `protocol`. Used for create/update body validation.
export const InboundConfigByProtocol = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('hysteria'), config: HysteriaConfigSchema }),
  z.object({ protocol: z.literal('xray'), config: XrayConfigSchema }),
  z.object({ protocol: z.literal('amneziawg'), config: AmneziawgConfigSchema }),
  z.object({ protocol: z.literal('wireguard'), config: WireguardConfigSchema }),
  z.object({ protocol: z.literal('naive'), config: NaiveConfigSchema }),
  z.object({ protocol: z.literal('shadowsocks'), config: ShadowsocksConfigSchema }),
  z.object({ protocol: z.literal('mtproto'), config: MtprotoConfigSchema }),
  z.object({ protocol: z.literal('mieru'), config: MieruConfigSchema }),
  z.object({ protocol: z.literal('tuic'), config: TuicConfigSchema }),
  z.object({ protocol: z.literal('anytls'), config: AnytlsConfigSchema }),
  z.object({ protocol: z.literal('shadowtls'), config: ShadowtlsConfigSchema }),
]);

// Public-facing host the panel emits in client URIs. Must be a hostname or
// IP: RFC 1123 hostname or IPv4 dotted-quad. Length capped at 253 (RFC).
const PublicHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    'Must be a valid hostname or IPv4',
  );

const BaseFields = z.object({
  nodeId: z.uuid(),
  name: NameSchema,
  port: PortSchema,
  enabled: z.boolean().default(true),
  // Slice 25: separate the public-facing client-URL host from the mTLS
  // control-plane endpoint (`node.address`). Empty string is treated like
  // null on the way in, so admins can clear the field in the UI.
  publicHost: PublicHostSchema.optional()
    .or(z.literal('').transform(() => undefined))
    .optional(),
  publicPort: PortSchema.optional(),
});

export const CreateInboundSchema = z.intersection(BaseFields, InboundConfigByProtocol);
export type CreateInboundInput = z.infer<typeof CreateInboundSchema>;

// Update never changes `protocol` (would invalidate per-protocol creds and
// break already-issued client URIs). To switch protocols, delete + recreate.
// The new config (if provided) must be the right shape for the existing
// inbound's protocol, service.ts validates that before persisting.
export const UpdateInboundSchema = z.object({
  name: NameSchema.optional(),
  port: PortSchema.optional(),
  enabled: z.boolean().optional(),
  // `null` explicitly clears the override; `undefined` (omitted) keeps the
  // current value. Empty string from a form input also clears.
  publicHost: PublicHostSchema.nullable()
    .or(z.literal('').transform(() => null))
    .optional(),
  publicPort: PortSchema.nullable().optional(),
  /** Protocol-specific config, must match the existing inbound's protocol. */
  config: z.unknown().optional(),
});
export type UpdateInboundInput = z.infer<typeof UpdateInboundSchema>;

export const PROTOCOL_CONFIG_SCHEMAS = {
  hysteria: HysteriaConfigSchema,
  xray: XrayConfigSchema,
  amneziawg: AmneziawgConfigSchema,
  wireguard: WireguardConfigSchema,
  naive: NaiveConfigSchema,
  shadowsocks: ShadowsocksConfigSchema,
  mtproto: MtprotoConfigSchema,
  mieru: MieruConfigSchema,
  tuic: TuicConfigSchema,
  anytls: AnytlsConfigSchema,
  shadowtls: ShadowtlsConfigSchema,
} as const;

export const ListInboundsQuerySchema = z.object({
  nodeId: z.uuid().optional(),
  protocol: z.enum(['hysteria', 'xray', 'amneziawg', 'wireguard', 'naive', 'shadowsocks', 'mtproto', 'mieru', 'tuic', 'anytls', 'shadowtls']).optional(),
});
export type ListInboundsQuery = z.infer<typeof ListInboundsQuerySchema>;

export const InboundIdParamSchema = z.object({ id: z.uuid() });
export type InboundIdParam = z.infer<typeof InboundIdParamSchema>;
