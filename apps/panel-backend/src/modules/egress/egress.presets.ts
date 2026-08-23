// B2a - vendored zapret2 egress strategy presets.
//
// ss-zapret2 (https://github.com/vernette/ss-zapret2) is a Docker stack that
// pairs bol-van's zapret2 DPI-desync engine (nfqws/nftables) with Shadowsocks +
// SOCKS frontends. On a node sitting INSIDE a censored network (scenario A, an
// RF residential exit), it runs as a SOCKS proxy whose OWN egress zapret2
// desyncs: validated on a real node 2026-06-24, nfqws lives in the proxy's
// netns and desyncs the PROXIED egress, not the host's. The integration is
// therefore "socks-via-container": the node's egress policy routes the flows
// the operator named INTO that SOCKS frontend (egress.policy.ts compiles the
// outbound), and they come out desynced. The client entry stays our own
// multi-user xray stack; ss-zapret2's single-user SS frontend is unused.
//
// A "preset" is the BODY of zapret2's `config` file (the standard zapret
// KEY=VALUE format, sourced by the zapret init scripts). The panel resolves a
// node's chosen preset (+ structured overrides) into a final config body and
// pushes it to the node, which writes it and restarts zapret2. Bodies are
// vendored + version-pinned here (like the awg tag pins in U1) so a preset is a
// reviewable artefact, not a moving upstream target.
//
// Pin: upstream `config.default` @ vernette/ss-zapret2 image tag v1.0.2
// (master, 2026-06). Bump deliberately; re-run the preset validation test.

/**
 * Where ss-zapret2's SOCKS frontend listens by default (its .env SOCKS_PORT,
 * mirrored by iceslab_zapret2_socks_port in the ansible role). Per-node
 * overridable on the stored config.
 */
export const DEFAULT_ZAPRET2_SOCKS_PORT = 1080;

/** Outbound tag for the socks outbound that feeds the local zapret2 proxy. */
export const ZAPRET2_OUTBOUND_TAG = 'ext-zapret2';

/**
 * rf-default: the upstream ss-zapret2 `config.default`, verbatim. Targets the
 * common RU-blocked set (YouTube/Google video) with a TLS multisplit + fake
 * ClientHello and a QUIC fake; HTTP method-eol for plain :80. A sane starting
 * strategy; F3 (node self-tune via blockcheckw) will add per-AS variants.
 */
const RF_DEFAULT = `FWTYPE=iptables

SET_MAXELEM=522288

IPSET_OPT="hashsize 262144 maxelem $SET_MAXELEM"

IP2NET_OPT4="--prefix-length=22-30 --v4-threshold=3/4"

IP2NET_OPT6="--prefix-length=56-64 --v6-threshold=5"

AUTOHOSTLIST_INCOMING_MAXSEQ=4096

AUTOHOSTLIST_RETRANS_MAXSEQ=32768

AUTOHOSTLIST_RETRANS_RESET=1

AUTOHOSTLIST_RETRANS_THRESHOLD=3

AUTOHOSTLIST_FAIL_THRESHOLD=3

AUTOHOSTLIST_FAIL_TIME=60

AUTOHOSTLIST_UDP_IN=1

AUTOHOSTLIST_UDP_OUT=4

AUTOHOSTLIST_DEBUGLOG=0

MDIG_THREADS=30

GZIP_LISTS=1

DESYNC_MARK=0x40000000

DESYNC_MARK_POSTNAT=0x20000000

NFQWS2_ENABLE=1

NFQWS2_PORTS_TCP=80,443

NFQWS2_PORTS_UDP=443

NFQWS2_TCP_PKT_OUT=20

NFQWS2_TCP_PKT_IN=10

NFQWS2_UDP_PKT_OUT=5

NFQWS2_UDP_PKT_IN=3

NFQWS2_OPT="

--filter-tcp=80 --filter-l7=http --payload http_req --lua-desync=http_methodeol --new

--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --hostlist-domains=youtube.com,googlevideo.com,youtubei.googleapis.com,ggpht.com --lua-desync=multisplit:pos=10:seqovl=1 --new

--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=fake:blob=fake_default_tls:tcp_ts=-1000:repeats=1 --new

--filter-udp=443 --filter-l7=quic --payload=quic_initial --lua-desync=fake:blob=fake_default_quic:repeats=6

"

MODE_FILTER=none

FLOWOFFLOAD=donttouch

INIT_APPLY_FW=1

DISABLE_IPV6=1

FILTER_TTL_EXPIRED_ICMP=1
`;

/** name → zapret2 config body. The single source of truth for valid preset names. */
export const ZAPRET2_PRESETS: Readonly<Record<string, string>> = Object.freeze({
  'rf-default': RF_DEFAULT,
});

export type Zapret2PresetName = keyof typeof ZAPRET2_PRESETS;

export const DEFAULT_ZAPRET2_PRESET = 'rf-default';

export function isKnownPreset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ZAPRET2_PRESETS, name);
}

export function getPresetBody(name: string): string | undefined {
  return isKnownPreset(name) ? ZAPRET2_PRESETS[name] : undefined;
}

export function listPresetNames(): string[] {
  return Object.keys(ZAPRET2_PRESETS);
}
