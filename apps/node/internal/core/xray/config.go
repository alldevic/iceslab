// Package xray implements CoreAdapter for Xray-core. Slice 17 ships VLESS +
// REALITY support via the config-restart pattern: every AddUser / RemoveUser
// regenerates `config.json` and restarts the xray subprocess. Brief downtime
// per mutation (~1s) is acceptable for the initial multi-core release.
//
// A future Phase 3 slice may switch to gRPC `proxyman.HandlerService.AlterInbound`
// for live user management with no restart, once we vendor the proto types.
package xray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// InboundConfig is the static part of the Xray config, generated once from
// admin settings (slice 23 will move these into the inbounds table) and kept
// constant across user mutations.
type InboundConfig struct {
	// Tag uniquely identifies the inbound inside Xray. Default: "vless-in".
	Tag string

	// ListenHost is the bind address. Default: "0.0.0.0".
	ListenHost string

	// ListenPort is the public TCP port for VLESS+REALITY. Default: 443.
	ListenPort int

	// REALITY settings, interface-level, not per-user. Slice 23 moves
	// these into the inbounds table and lets the admin edit them.
	RealityDest        string   // e.g. "www.cloudflare.com:443"
	RealityServerNames []string // e.g. ["www.cloudflare.com"]
	RealityPrivateKey  string   // x25519 private key (paired pubkey advertised in URI)
	RealityShortIDs    []string // hex strings, max 16 chars each

	// B3 REALITY extras. RealityXver (0|1|2) is the protocol version mirrored
	// to the upstream dest; 0 (default) renders as before. RealityMaxTimeDiff
	// (ms) caps the client/node clock skew REALITY tolerates; 0 (default) omits
	// the field and leaves xray-core's built-in value.
	RealityXver        int
	RealityMaxTimeDiff int

	// U5 post-quantum. RealityMldsa65Seed is the server's ML-DSA-65 seed
	// (`xray mldsa65`) that adds an extra post-quantum signature to the REALITY
	// certificate; empty (default) omits the field, rendering byte-identically
	// to pre-U5. NOTE: enabling it requires the `target` cert to be >3500 bytes
	// (xray-core constraint). Needs an Xray build with ML-DSA-65 REALITY support.
	RealityMldsa65Seed string

	// U5 VlessDecryption is the server-side VLESS-Encryption string
	// (`mlkem768x25519plus.native....`, from `xray vlessenc`) — post-quantum
	// (ML-KEM-768) native VLESS encryption with PFS. Empty (default) renders the
	// VLESS inbound's decryption as "none", byte-identical to pre-U5. Only the
	// vless subprotocol carries it (trojan/vmess ignore it).
	VlessDecryption string

	// G probe resistance. Rate-limit (bytes/sec) for UNVERIFIED REALITY
	// fallback connections: a scanner that fails REALITY auth is forwarded to
	// the target throttled, so it sees a slow site, not a full-speed proxy.
	// 0 (default) omits the field and renders byte-identically to pre-G.
	RealityLimitFallbackUploadBytesPerSec   int
	RealityLimitFallbackDownloadBytesPerSec int

	// RealityMode (K9-B) selects how REALITY borrows a TLS identity:
	//   - "" / "steal-others": dest = an external camouflage site (default;
	//     works outside RU but SNI-IP-mismatches under RU-DPI).
	//   - "self-steal": dest = the node's own loopback TLS fallback
	//     (selfStealAddr) + serverNames = the node's domain, so SNI and IP are
	//     consistent. The adapter runs that fallback (see selfsteal.go) and
	//     withDefaults rewrites RealityDest to it.
	RealityMode string

	// RealityFallbackUpstream (G1) is the real site the self-steal local TLS
	// fallback reverse-proxies probe requests to, so a deep prober sees genuine
	// content instead of the stub landing page. Empty = static landing (the
	// default). Only meaningful when RealityMode is self-steal.
	RealityFallbackUpstream string

	// Flow controls Vision (xtls-rprx-vision) on the client side; empty disables.
	Flow string

	// ApiPort is the loopback port the gRPC StatsService listens on. Default
	// 8080. Slice 24c, adapter shells out to `xray api statsquery
	// -server 127.0.0.1:<ApiPort>` to read+drain per-user byte counters.
	// MUST stay on 127.0.0.1 (renderConfig hardcodes the listen host),
	// exposing it externally would let anyone read+reset all counters.
	ApiPort int

	// Network is the stream transport. Empty/"raw" → REALITY canonical.
	// Slice 24c part 2 adds `xhttp`/`ws`/`grpc`/`httpupgrade`/`kcp` branches,
	// Vision flow is incompatible with all but `raw`/`xhttp`; the operator
	// is responsible for aligning Flow with Network at form level.
	Network string

	// Path is used by `ws`, `xhttp`, `httpupgrade` transports. Default "/".
	Path string

	// HostHeader overrides the Host header for `ws`/`xhttp`/`httpupgrade`.
	// Empty → use the connect host as Host.
	HostHeader string

	// ServiceName is required when Network is `grpc` (the gRPC service
	// identifier the inbound listens on).
	ServiceName string

	// Subprotocol carries which Xray-core protocol the user-facing inbound
	// runs: "vless" (default) or "trojan". Slice 24c part 3, same REALITY
	// stack drives both, only the inbound's `protocol` and `clients` shape
	// differ. Trojan password reuses user.xrayUuid (set on the client side
	// of the panel; on the agent's renderConfig we map xrayClient.ID into
	// `password` for trojan instead of `id` for vless).
	Subprotocol string

	// Security is the stream security layer: "reality" (default / empty),
	// "none" (plain transport, e.g. ws/httpupgrade behind a CDN that terminates
	// TLS, or local testing), or "tls" (node-terminated TLS with an operator-
	// supplied cert). When "none" the Reality* fields are not required; when
	// "tls" the TLS* fields below are required and Reality* are ignored.
	Security string

	// TLS settings (Security == "tls"). Cert + key are PEM, embedded inline in
	// tlsSettings.certificates (no ACME on the node).
	TLSServerName string
	TLSCert       string
	TLSKey        string

	// B3 TLSRejectUnknownSni: when true, reject TLS handshakes whose SNI
	// matches no served server name. false (default) leaves the field off, so
	// pre-B3 configs render identically.
	TLSRejectUnknownSni bool

	// B3 XHTTP knobs (Network == "xhttp"). XhttpMode is the packet framing:
	// "" / "auto" (default) lets xray pick; "packet-up" / "stream-up" /
	// "stream-one" force a specific mode. XhttpPaddingBytes is a request-padding
	// byte range (e.g. "100-1000"); empty (default) disables padding.
	XhttpMode         string
	XhttpPaddingBytes string

	// B3 GrpcMultiMode (Network == "grpc"): multiplex several gRPC streams per
	// connection. false (default) keeps the single-stream behaviour.
	GrpcMultiMode bool

	// Warp is the optional Cloudflare WARP egress (per-node egress v1). When
	// non-nil, renderConfig adds a `wireguard` outbound to WARP and routes this
	// inbound's user traffic through it instead of `direct`. nil = direct egress
	// (default). See docs/studies/STUDY-warp-native.md.
	Warp *WarpConfig

	// U4 configurable anti-abuse. AbusePolicy gates the built-in routing
	// BLOCK rules (BitTorrent, SMTP port 25) and the DNS-hijack protection
	// rule (see renderConfigWithCascade). A nil pointer (the field absent on
	// the wire) means "all three enabled", byte-identical to the pre-U4
	// hardcoded behaviour. A non-nil policy renders each rule only when its
	// flag is true, so an operator can selectively relax a node's AUP
	// enforcement (e.g. allow BitTorrent on a residential exit). Shared with
	// the shadowsocks core, which renders the same rules.
	AbusePolicy *core.AbusePolicy

	// RoutingFragments (B1) is the node's compiled server-side egress policy.
	// nil (the field absent on the wire) means default routing, byte-identical
	// to pre-B1. See the RoutingFragments type.
	RoutingFragments *RoutingFragments
}

// WarpConfig holds Cloudflare WARP egress credentials from a wgcf-style device
// registration, provisioned by the panel. PublicKey/Endpoint/MTU fall back to
// Cloudflare's well-known defaults when empty. Reserved is the account client_id
// as a 3-byte array (required in some regions); empty or exactly 3 bytes. The
// json tags let this type double as the panel-pushed wire shape (inbound.warp).
type WarpConfig struct {
	SecretKey string   `json:"secretKey"`
	Address   []string `json:"address"`
	PublicKey string   `json:"publicKey,omitempty"`
	Endpoint  string   `json:"endpoint,omitempty"`
	Reserved  []int    `json:"reserved,omitempty"`
	MTU       int      `json:"mtu,omitempty"`
}

const (
	// warpDefault* are Cloudflare WARP's well-known peer parameters (see study).
	warpDefaultPublicKey = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
	warpDefaultEndpoint  = "162.159.192.1:2408"
	warpDefaultMTU       = 1280
)

func (c *InboundConfig) withDefaults() InboundConfig {
	out := *c
	if out.Tag == "" {
		out.Tag = "vless-in"
	}
	if out.ListenHost == "" {
		out.ListenHost = "0.0.0.0"
	}
	if out.ListenPort == 0 {
		out.ListenPort = 443
	}
	// Empty Flow is intentional for non-raw transports (xhttp/ws/grpc/kcp/
	// httpupgrade), Vision only works with raw (TCP). Earlier versions
	// forced empty → "xtls-rprx-vision" as a default, which broke xhttp:
	// xray rejected clients with "client flow is empty" because the server
	// account had Vision flow set while the client (xhttp transport)
	// connected without it. Trust the panel-side value as-is.
	if out.ApiPort == 0 {
		out.ApiPort = 8080
	}
	// K9-B self-steal: REALITY's dest is the node's own loopback TLS fallback,
	// regardless of what (if anything) the panel sent for RealityDest.
	if out.RealityMode == selfStealModeValue {
		out.RealityDest = selfStealAddr
	}
	return out
}

func (c *InboundConfig) validate() error {
	// WARP egress is orthogonal to inbound security, so validate it first.
	if c.Warp != nil {
		if c.Warp.SecretKey == "" {
			return errors.New("Warp.SecretKey is required when WARP egress is enabled")
		}
		if len(c.Warp.Address) == 0 {
			return errors.New("Warp.Address must have at least one entry")
		}
		if len(c.Warp.Reserved) != 0 && len(c.Warp.Reserved) != 3 {
			return errors.New("Warp.Reserved must be empty or exactly 3 bytes")
		}
	}
	// security="none" is a plain transport (CDN-fronted ws/httpupgrade or local
	// testing) with no REALITY material to validate.
	if c.Security == "none" {
		return nil
	}
	// security="tls" terminates TLS on the node with an operator-supplied cert.
	if c.Security == "tls" {
		if c.TLSCert == "" || c.TLSKey == "" {
			return errors.New("TLSCert and TLSKey are required for tls security")
		}
		return nil
	}
	if c.RealityPrivateKey == "" {
		return errors.New("RealityPrivateKey is required")
	}
	if len(c.RealityServerNames) == 0 {
		return errors.New("RealityServerNames must have at least one entry")
	}
	if len(c.RealityShortIDs) == 0 {
		return errors.New("RealityShortIDs must have at least one entry")
	}
	// K9-B self-steal: RealityDest is the node's own loopback TLS fallback,
	// supplied by withDefaults (selfStealAddr). The panel needn't send a dest,
	// and the loopback/SSRF guard below is intentionally bypassed: this
	// loopback target is our managed fallback, not an operator-pointed host.
	if c.RealityMode == selfStealModeValue {
		return nil
	}
	if c.RealityDest == "" {
		return errors.New("RealityDest is required")
	}
	// REALITY connects to RealityDest as the upstream fallback. A panel that
	// sets this to "127.0.0.1:22" or an internal RFC1918 address turns the
	// node into an SSRF gadget, anyone holding a REALITY URI can probe the
	// node's localhost or private LAN. Refuse loopback / link-local / private
	// destinations; production REALITY always points at a public Internet
	// camouflage host (e.g. www.cloudflare.com:443).
	if err := validateRealityDest(c.RealityDest); err != nil {
		return fmt.Errorf("RealityDest: %w", err)
	}
	return nil
}

func validateRealityDest(dest string) error {
	host, port, err := net.SplitHostPort(dest)
	if err != nil {
		return fmt.Errorf("must be host:port, got %q: %w", dest, err)
	}
	if host == "" || port == "" {
		return fmt.Errorf("host and port both required, got %q", dest)
	}
	// Hostnames are accepted (operator's typical case). When the value
	// parses as an IP literal, reject any that resolve to an unroutable or
	// internal block.
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("IP %s is loopback/private/link-local, refuse to use as REALITY fallback", host)
		}
	}
	return nil
}

// xrayClient mirrors Xray's client-config object.
type xrayClient struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Flow  string `json:"flow,omitempty"`
}

// CascadeFragments are the extra xray config pieces a cascade hop contributes,
// generated panel-side (C2 buildCascadeConfigs) and pushed to the node alongside
// the inbound config:
//   - Inbounds:     the link-IN inbound (transit/exit nodes receive the prev hop)
//   - Outbounds:    the link-OUT outbound (entry/transit nodes dial the next hop)
//   - RoutingRules: per-role rules (entry: user->link-out; transit: link-in->
//     link-out; exit: link-in->direct). Appended AFTER the base rules so the
//     DNS-hijack and BitTorrent/SMTP block rules still take precedence.
//
// Each element is a raw JSON object so the panel owns the exact xray shape and
// the node-agent stays protocol-agnostic. Nil/empty = a non-cascade node, in
// which case renderConfig output is byte-identical to before this feature.
type CascadeFragments struct {
	Inbounds     []json.RawMessage `json:"inbounds"`
	Outbounds    []json.RawMessage `json:"outbounds"`
	RoutingRules []json.RawMessage `json:"routingRules"`
	// LinkIngressPort is the inter-hop link-IN port this node listens on (the
	// previous hop dials it). The node-agent opens UFW for it; renderConfig
	// ignores these two fields (the port already lives inside the Inbounds JSON).
	// 0 on the entry hop (no link-in).
	LinkIngressPort int `json:"linkIngressPort,omitempty"`
	// LinkAllowFrom is the source IP/CIDR/host allowed to reach LinkIngressPort
	// (the previous hop's address). Empty -> the agent opens the port to anywhere.
	LinkAllowFrom []string `json:"linkAllowFrom,omitempty"`
	// Observatory is the optional top-level `observatory` block a latency-
	// balanced ("auto") entry uses to probe its link-out outbounds by RTT. nil on
	// a plain single-exit cascade, so the config stays byte-identical then.
	Observatory json.RawMessage `json:"observatory,omitempty"`
	// Balancers are the optional `routing.balancers` entries a balanced entry
	// exposes; its user routing rule targets one via `balancerTag` (instead of a
	// fixed `outboundTag`), so xray picks the lowest-ping exit per connection.
	Balancers []json.RawMessage `json:"balancers,omitempty"`
	// GeoAssets are panel-managed geo databases (the source mirror + composed
	// ext: custom .dat) this node must fetch+install so its geosite:/ext: routing
	// rules resolve. Empty = nothing to fetch (node uses the bundled databases).
	GeoAssets []GeoAssetSpec `json:"geoAssets,omitempty"`
	// DomainStrategy overrides the config's global routing.domainStrategy for a
	// geo-split entry that needs on-demand IP resolution ("IPOnDemand") so its
	// geoip/ip rules fire ahead of the always-true catch-all. Empty = keep the
	// default (byte-identical to a plain cascade). Validated against a fixed
	// allowlist before use so a bad wire value can't inject an arbitrary strategy.
	DomainStrategy string `json:"domainStrategy,omitempty"`
}

// domainStrategyResolution ranks the strategies by how far xray will go to
// learn a connection's IP: AsIs never resolves, IPIfNonMatch resolves only when
// nothing matched, IPOnDemand resolves as soon as a rule needs an IP. The
// ranking is what lets two independent overrides combine instead of clobbering
// each other (see strongerDomainStrategy).
var domainStrategyResolution = map[string]int{
	"AsIs":         0,
	"IPIfNonMatch": 1,
	"IPOnDemand":   2,
}

// defaultDomainStrategy is what a config renders with when nothing asks for
// more. Kept as the floor of strongerDomainStrategy so an unset or unknown
// override cannot render a config that resolves LESS than before.
const defaultDomainStrategy = "IPIfNonMatch"

// strongerDomainStrategy picks the most-resolving of the requested strategies,
// defaulting when none is set.
//
// Most-resolving wins because every request here exists to make ip/geoip rules
// fire at all: honouring the weaker one would leave the other feature's rules
// silently dead, which is the failure both overrides were added to prevent.
// Resolving more than asked costs a DNS lookup on a flow that would otherwise
// have skipped it, which is the cheaper mistake.
func strongerDomainStrategy(requested ...string) string {
	best := defaultDomainStrategy
	for _, s := range requested {
		if domainStrategyResolution[s] > domainStrategyResolution[best] {
			best = s
		}
	}
	return best
}

// cascadeDomainStrategy is the geo split's override on a cascade entry, or "".
func cascadeDomainStrategy(cascade *CascadeFragments) string {
	if cascade == nil || !isKnownDomainStrategy(cascade.DomainStrategy) {
		return ""
	}
	return cascade.DomainStrategy
}

// routingDomainStrategy is the egress policy's override, or "". Allowlisted for
// the same reason the cascade one is: a malformed wire value must fall back to
// the default rather than reach xray, which refuses to start on an unknown
// strategy and would take the node down.
func routingDomainStrategy(rf *RoutingFragments) string {
	if rf == nil || !isKnownDomainStrategy(rf.DomainStrategy) {
		return ""
	}
	return rf.DomainStrategy
}

// isKnownDomainStrategy allowlists the xray routing.domainStrategy values the
// panel may override an entry with, so a malformed/hostile wire value cannot
// inject an arbitrary strategy string (it falls back to the default instead).
func isKnownDomainStrategy(s string) bool {
	switch s {
	case "AsIs", "IPIfNonMatch", "IPOnDemand":
		return true
	default:
		return false
	}
}

// RoutingFragments (B1) is a node's compiled egress policy: structured rules
// that send matching traffic (geosite/geoip/domain/port) to a chosen outbound,
// plus the outbound definitions those rules name (e.g. a socks outbound to a
// local desync proxy). Rendered into xray routing.rules AFTER the U4 block
// rules (so blocks win), BEFORE the cascade rules (so a specific geosite route
// beats the cascade catch-all) and before the WARP rule (so the policy decides
// and WARP is what UNMATCHED traffic falls through to). nil/empty means the
// node routes exactly as before, byte-identical to pre-B1.
//
// The panel compiles this from the operator's policy against the capabilities
// the node actually has, so the node never sees a rule naming an outbound that
// does not exist here: an unknown outboundTag is a config xray refuses, which
// would take the node down over one stale policy row.
//
// geosite:*/geoip:* categories are bundled in the xray binary, so standard
// categories need no .dat delivery.
type RoutingFragments struct {
	Rules []RoutingRule `json:"rules"`
	// Outbounds are the custom xray outbound objects (raw JSON, panel-owned
	// shape like cascade outbounds) a rule's OutboundTag names. Appended to the
	// config's outbounds verbatim.
	Outbounds []json.RawMessage `json:"outbounds,omitempty"`
	// DomainStrategy overrides routing.domainStrategy for the whole config.
	//
	// Why a policy needs this: with sniffing on, a TLS/HTTP/QUIC connection is
	// routed by its sniffed DOMAIN, and under the default IPIfNonMatch xray
	// resolves that domain to an IP for a second rule pass only if NO rule
	// matched the first. A node with a cascade catch-all or a WARP rule always
	// has a later rule that matches everything, so the second pass never
	// happens and an ip/geoip rule would never fire. The panel sets this to
	// IPOnDemand when the compiled policy contains an ip/geoip matcher, which
	// resolves as a rule needs an IP. Empty keeps the default.
	//
	// CAVEAT (same one the geo subsystem carries): IPOnDemand resolves through
	// the NODE's DNS, which can answer differently than the client's resolver
	// for CDN / geo-DNS names, so a geoip match is approximate. Confirm on a
	// live node before relying on a geoip split.
	DomainStrategy string `json:"domainStrategy,omitempty"`
}

// RoutingRule is one structured xray routing rule. At least one matcher is set
// (the panel enforces this); OutboundTag names a built-in outbound
// (direct/blocked/dns-out), a WARP/cascade outbound the config already carries,
// or a RoutingFragments.Outbounds entry.
type RoutingRule struct {
	Domain      []string `json:"domain,omitempty"`  // e.g. ["geosite:youtube", "example.com"]
	IP          []string `json:"ip,omitempty"`      // e.g. ["geoip:ru", "10.0.0.0/8"]
	Port        string   `json:"port,omitempty"`    // e.g. "443" or "1000-2000"
	Network     string   `json:"network,omitempty"` // "tcp" | "udp" | "tcp,udp"
	OutboundTag string   `json:"outboundTag"`
}

// toXrayRule renders the structured rule into the map xray's routing.rules
// expects, emitting only the matchers that are set.
func (r RoutingRule) toXrayRule() map[string]any {
	m := map[string]any{"type": "field", "outboundTag": r.OutboundTag}
	if len(r.Domain) > 0 {
		m["domain"] = r.Domain
	}
	if len(r.IP) > 0 {
		m["ip"] = r.IP
	}
	if r.Port != "" {
		m["port"] = r.Port
	}
	if r.Network != "" {
		m["network"] = r.Network
	}
	return m
}

// renderConfig produces a complete Xray config.json blob for the given users.
// Marshaled as indented JSON for human-readability when an operator needs to
// inspect what the adapter wrote. Thin wrapper over renderConfigWithCascade for
// the non-cascade path.
//
// Slice 24c, per-user stats. The config now wires up Xray's StatsService:
//
//   - `stats: {}` enables internal counter collection
//   - `policy.levels."0".statsUserUplink/Downlink: true` tells Xray to count
//     bytes per client (Xray uses the client's `email` field as the stat key,
//     and we set email = userId so panel can correlate)
//   - A dedicated `api` inbound on 127.0.0.1:8080 (loopback only) exposes
//     the gRPC StatsService, the adapter shells out to `xray api statsquery
//     -server 127.0.0.1:8080 -pattern user -reset` to read+drain counters.
//   - A `routing.rules` entry pins traffic from the api inbound to the api
//     outbound; without it Xray would refuse the loopback management calls.
//
// The api inbound MUST stay on 127.0.0.1, exposing it externally would
// give anyone the ability to read all traffic counters and reset them.
func renderConfig(inbound InboundConfig, users []xrayClient) ([]byte, error) {
	return renderConfigWithCascade(inbound, users, nil)
}

// renderConfigWithCascade renders ONE user inbound; renderMultiConfig renders
// several. Kept as a thin wrapper so the many existing call sites and tests
// that deal with a single inbound stay unchanged.
func renderConfigWithCascade(inbound InboundConfig, users []xrayClient, cascade *CascadeFragments) ([]byte, error) {
	return renderMultiConfig([]InboundConfig{inbound}, users, cascade, inbound.withDefaults().ApiPort)
}

// renderConfigWithCascade is renderConfig plus optional cascade fragments (C3).
// When cascade is nil the output is byte-identical to the pre-cascade config.
// renderMultiConfig renders N user-facing inbounds into one xray config.
//
// One process, not one per inbound: two xray instances on a node would fight
// over the stats API port and the config path, and each would carry its own
// copy of the user list. The core is built to serve several inbounds, so this
// follows its grain.
//
// Every inbound needs a UNIQUE tag and port, or xray refuses the whole config
// and the node loses ALL of them rather than the one that clashed. The tag is
// derived from the panel's inbound id (see Adapter.inbounds), so it is stable
// across pushes - traffic counters are tagged with it.
//
// The same user list is served on every inbound: a user's access is decided by
// the panel when it pushes bindings, not by which door they walk through.
// An EMPTY list is legal and means "this node serves nobody": the panel removed
// the last inbound. Refusing to render that was a real failure - the render
// errored, the old config stayed on disk, and the core kept serving the inbound
// the operator had just deleted (field, 2026-08-10). `apiPort` carries the
// process-level identity that would otherwise come from the first inbound, so
// the management inbound survives having no user inbounds to sit beside.
func renderMultiConfig(
	inboundCfgs []InboundConfig,
	users []xrayClient,
	cascade *CascadeFragments,
	apiPort int,
) ([]byte, error) {
	inbounds := make([]any, 0, len(inboundCfgs)+1)
	seenTags := make(map[string]struct{}, len(inboundCfgs))
	seenPorts := make(map[int]struct{}, len(inboundCfgs))
	var cfg InboundConfig
	for _, ib := range inboundCfgs {
		if err := ib.validate(); err != nil {
			return nil, err
		}
		cfg = ib.withDefaults()
		// Reject a clash here, with a message naming it, rather than handing
		// xray a config it rejects wholesale with a parser error.
		if _, dup := seenTags[cfg.Tag]; dup {
			return nil, fmt.Errorf("render xray config: duplicate inbound tag %q", cfg.Tag)
		}
		if _, dup := seenPorts[cfg.ListenPort]; dup {
			return nil, fmt.Errorf("render xray config: two inbounds on port %d", cfg.ListenPort)
		}
		seenTags[cfg.Tag] = struct{}{}
		seenPorts[cfg.ListenPort] = struct{}{}
		inbounds = append(inbounds, map[string]any{
			"tag":            cfg.Tag,
			"listen":         cfg.ListenHost,
			"port":           cfg.ListenPort,
			"protocol":       userInboundProtocol(cfg),
			"settings":       buildUserInboundSettings(cfg, users),
			"streamSettings": buildStreamSettings(cfg),
			// Sniffing: slice 24c part 2. Lets routing rules see the
			// real destination protocol/SNI rather than just the IP/port,
			// which is needed for the `geosite:` and `protocol:` matchers
			// below to actually fire. `routeOnly: false` (default) means
			// the sniffed value also drives the connection, so DNS-over-
			// HTTPS hijack-protection rules work too.
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []string{"http", "tls", "quic"},
			},
		})
	}

	// One management inbound for the whole process, not one per user inbound:
	// the stats API is per-core. The port is install-time identity, so it comes
	// from the caller rather than from an inbound - with no inbounds left there
	// would be none to read it from, and guessing the default would silently
	// break stats on a node whose operator moved the port.
	if apiPort == 0 {
		apiPort = cfg.ApiPort
	}
	inbounds = append(inbounds, map[string]any{
		"tag":      "api-in",
		"listen":   "127.0.0.1",
		"port":     apiPort,
		"protocol": "dokodemo-door",
		"settings": map[string]any{
			"address": "127.0.0.1",
		},
	})

	// Outbounds, slice 24c part 2:
	//   - `direct` (freedom): default exit
	//   - `dns-out`: DNS server outbound, routing rule below pins all
	//     `protocol: dns` traffic here so client DNS queries don't leak
	//     out via `direct` and reveal real destinations to the resolver
	//   - `blocked` (blackhole): drop target for BLOCK rules
	outbounds := []any{
		map[string]any{
			"protocol": "freedom",
			"tag":      "direct",
			"streamSettings": map[string]any{
				"sockopt": map[string]any{
					// BBR congestion control, measurably better throughput
					// on lossy networks (5-30% in our prod-runs). Requires
					// `net.core.default_qdisc=fq` + `net.ipv4.tcp_congestion
					// _control=bbr` in sysctl on the node, install-iceslab-node.sh
					// sets these (slice 23.1).
					"tcpCongestion": "bbr",
					"tcpFastOpen":   true,
				},
			},
		},
		map[string]any{"protocol": "dns", "tag": "dns-out"},
		map[string]any{"protocol": "blackhole", "tag": "blocked"},
	}

	// U4: the DNS-hijack / BitTorrent / SMTP rules are gated by cfg.AbusePolicy.
	// A nil policy (the field absent on the wire) keeps all three enabled, so
	// the output is byte-identical to the pre-U4 hardcoded behaviour. A non-nil
	// policy renders each rule only when its flag is set (the Blocks* accessors
	// are nil-safe, so the nil case needs no branch here). The api-in loopback
	// rule is unconditional (management traffic must always reach the api
	// outbound). Order is preserved (dns -> bittorrent -> smtp) so the all-true
	// case stays byte-identical to the previous literal.
	rules := []any{
		// Loopback management: api inbound traffic only ever talks
		// to the api outbound (the StatsService).
		map[string]any{
			"type":        "field",
			"inboundTag":  []string{"api-in"},
			"outboundTag": "api",
		},
	}
	// DNS hijack protection, route all DNS-protocol traffic to
	// the dns-out outbound so the upstream resolver can't see the
	// client's real IP.
	if cfg.AbusePolicy.BlocksDnsHijack() {
		rules = append(rules, map[string]any{
			"type":        "field",
			"protocol":    []string{"dns"},
			"outboundTag": "dns-out",
		})
	}
	// BLOCK rules, slice 24c part 2 anti-abuse:
	//   - BitTorrent: most VPS providers' AUP forbids it; one
	//     subscriber's torrenting can get the whole node nuked.
	//   - SMTP (port 25): outbound mail abuse / spam, providers
	//     blacklist the IP within hours.
	if cfg.AbusePolicy.BlocksTorrent() {
		rules = append(rules, map[string]any{
			"type":        "field",
			"protocol":    []string{"bittorrent"},
			"outboundTag": "blocked",
		})
	}
	if cfg.AbusePolicy.BlocksSmtp() {
		rules = append(rules, map[string]any{
			"type":        "field",
			"port":        "25",
			"outboundTag": "blocked",
		})
	}

	// B1: append the node's compiled egress policy. After the U4 block rules
	// (so DNS-hijack/BitTorrent/SMTP still win) and before the cascade rules and
	// the WARP rule below, both of which end in a catch-all: the policy decides
	// where a matched flow leaves, and whatever it does not match falls through
	// to the node's default egress. nil/empty adds nothing, so the render stays
	// byte-identical.
	if cfg.RoutingFragments != nil {
		for _, ob := range cfg.RoutingFragments.Outbounds {
			outbounds = append(outbounds, ob)
		}
		for _, rule := range cfg.RoutingFragments.Rules {
			rules = append(rules, rule.toXrayRule())
		}
	}

	// C3: append cascade fragments. Order matters: cascade rules come AFTER the
	// base block/dns rules so a cascade entry's catch-all (user traffic ->
	// link-out) doesn't shadow DNS-hijack/BitTorrent/SMTP handling.
	if cascade != nil {
		for _, ib := range cascade.Inbounds {
			inbounds = append(inbounds, ib)
		}
		for _, ob := range cascade.Outbounds {
			outbounds = append(outbounds, ob)
		}
		for _, r := range cascade.RoutingRules {
			rules = append(rules, r)
		}
	}

	// WARP egress (per-node v1): add the Cloudflare WARP wireguard outbound and
	// route this inbound's user traffic through it. Appended last so the DNS,
	// BitTorrent/SMTP block, and cascade rules still take precedence (warp +
	// cascade is out of v1 scope: cascade routing matches first, so the warp
	// rule simply never fires on a cascade node).
	if cfg.Warp != nil {
		outbounds = append(outbounds, buildWarpOutbound(cfg.Warp))
		rules = append(rules, map[string]any{
			"type":        "field",
			"inboundTag":  []string{cfg.Tag},
			"outboundTag": "warp",
		})
	}

	// C3-auto: a latency-balanced entry ships `routing.balancers` (its user rule
	// targets one via balancerTag) plus a top-level `observatory` probing the
	// link-out outbounds. Both are raw JSON the panel owns; nil/empty = no
	// balancer, so the output stays byte-identical to a plain / non-cascade node.
	// Resolution strategy. Two independent features ask to raise it, for the
	// same reason: a rule that matches on IP cannot fire under IPIfNonMatch once
	// a later rule matches everything, and both a cascade entry's geo split and
	// a node's egress policy can carry such rules. There is one
	// routing.domainStrategy for the whole config, so the two requests have to
	// resolve to one value rather than one silently overwriting the other.
	domainStrategy := strongerDomainStrategy(cascadeDomainStrategy(cascade), routingDomainStrategy(cfg.RoutingFragments))
	routing := map[string]any{
		"domainStrategy": domainStrategy,
		"rules":          rules,
	}
	if cascade != nil && len(cascade.Balancers) > 0 {
		bals := make([]any, 0, len(cascade.Balancers))
		for _, b := range cascade.Balancers {
			bals = append(bals, b)
		}
		routing["balancers"] = bals
	}

	doc := map[string]any{
		"log": map[string]any{
			"loglevel": "info",
		},
		"stats": map[string]any{},
		"api": map[string]any{
			"tag":      "api",
			"services": []string{"StatsService", "HandlerService"},
		},
		"policy": map[string]any{
			"levels": map[string]any{
				"0": map[string]any{
					"statsUserUplink":   true,
					"statsUserDownlink": true,
				},
			},
			"system": map[string]any{
				"statsInboundUplink":   true,
				"statsInboundDownlink": true,
			},
		},
		"inbounds":  inbounds,
		"outbounds": outbounds,
		"routing":   routing,
	}
	// A balanced entry also carries the top-level `observatory` (nil on every
	// other node, so the key is simply absent there).
	if cascade != nil && len(cascade.Observatory) > 0 {
		doc["observatory"] = cascade.Observatory
	}
	return json.MarshalIndent(doc, "", "  ")
}

// userInboundProtocol picks the Xray-core inbound protocol for the user-
// facing endpoint based on the configured subprotocol. Both protocols share
// the REALITY streamSettings stack and the api/stats infrastructure, only
// the inbound `protocol` and the `clients` element shape differ.
func userInboundProtocol(cfg InboundConfig) string {
	switch cfg.Subprotocol {
	case "trojan":
		return "trojan"
	case "vmess":
		return "vmess"
	default:
		return "vless"
	}
}

// buildUserInboundSettings produces the inbound's `settings` block. VLESS
// expects `{clients: [{id, email, flow}], decryption: "none"}`; Trojan
// expects `{clients: [{password, email}]}` (Trojan defines no flow and no
// payload encryption beyond TLS). Slice 24c part 3.
//
// We reuse `xrayClient.ID` as the Trojan password, UUIDs have plenty of
// entropy and the user already has one (`user.xrayUuid`) tracked by the
// panel, so we don't grow the credential surface.
func buildUserInboundSettings(cfg InboundConfig, users []xrayClient) map[string]any {
	if cfg.Subprotocol == "trojan" {
		clients := make([]map[string]any, 0, len(users))
		for _, u := range users {
			clients = append(clients, map[string]any{
				"password": u.ID,
				"email":    u.Email,
			})
		}
		return map[string]any{
			"clients": clients,
		}
	}
	if cfg.Subprotocol == "vmess" {
		// VMess: per-user UUID, AEAD (alterId omitted = 0). No Vision flow and
		// no `decryption` field (VMess negotiates its own cipher via `scy` on
		// the client side).
		clients := make([]map[string]any, 0, len(users))
		for _, u := range users {
			clients = append(clients, map[string]any{
				"id":    u.ID,
				"email": u.Email,
			})
		}
		return map[string]any{
			"clients": clients,
		}
	}
	// VLESS — default. U5: when a VLESS-Encryption string is configured (ML-KEM-768
	// native encryption), it replaces the "none" decryption; empty -> "none",
	// byte-identical to pre-U5.
	decryption := "none"
	if cfg.VlessDecryption != "" {
		decryption = cfg.VlessDecryption
	}
	return map[string]any{
		"clients":    users,
		"decryption": decryption,
	}
}

// splitPEMLines turns a PEM blob into the line array xray's tlsSettings
// `certificate`/`key` fields expect. Trims surrounding whitespace and
// normalises CRLF so a pasted cert renders cleanly.
func splitPEMLines(pem string) []string {
	clean := strings.ReplaceAll(strings.TrimSpace(pem), "\r\n", "\n")
	return strings.Split(clean, "\n")
}

// buildStreamSettings selects the right Xray streamSettings shape for the
// configured network transport. REALITY+Vision canonical is `raw`; other
// transports are slice 24c part 2 additions.
func buildStreamSettings(cfg InboundConfig) map[string]any {
	network := cfg.Network
	if network == "" {
		network = "raw"
	}
	path := cfg.Path
	if path == "" {
		path = "/"
	}

	security := "reality"
	switch cfg.Security {
	case "none":
		security = "none"
	case "tls":
		security = "tls"
	}
	stream := map[string]any{
		"network":  network,
		"security": security,
	}
	// REALITY material is emitted only for the reality security layer; "none"
	// is a plain transport (the TLS, if any, is terminated by a fronting CDN).
	if security == "reality" {
		realitySettings := map[string]any{
			"show":        false,
			"dest":        cfg.RealityDest,
			"xver":        cfg.RealityXver,
			"serverNames": cfg.RealityServerNames,
			"privateKey":  cfg.RealityPrivateKey,
			"shortIds":    cfg.RealityShortIDs,
		}
		// B3: only emit maxTimeDiff when set, so the default (0) render stays
		// byte-identical to pre-B3 configs.
		if cfg.RealityMaxTimeDiff > 0 {
			realitySettings["maxTimeDiff"] = cfg.RealityMaxTimeDiff
		}
		// U5: post-quantum ML-DSA-65 signature on the REALITY cert. Emitted only
		// when set, so the default (empty) render stays byte-identical to pre-U5.
		if cfg.RealityMldsa65Seed != "" {
			realitySettings["mldsa65Seed"] = cfg.RealityMldsa65Seed
		}
		// G: throttle unverified fallback (probe) connections. Emitted only when
		// set, so the default (0) render stays byte-identical to pre-G configs.
		if cfg.RealityLimitFallbackUploadBytesPerSec > 0 {
			realitySettings["limitFallbackUpload"] = map[string]any{
				"afterBytes":       0,
				"bytesPerSec":      cfg.RealityLimitFallbackUploadBytesPerSec,
				"burstBytesPerSec": cfg.RealityLimitFallbackUploadBytesPerSec,
			}
		}
		if cfg.RealityLimitFallbackDownloadBytesPerSec > 0 {
			realitySettings["limitFallbackDownload"] = map[string]any{
				"afterBytes":       0,
				"bytesPerSec":      cfg.RealityLimitFallbackDownloadBytesPerSec,
				"burstBytesPerSec": cfg.RealityLimitFallbackDownloadBytesPerSec,
			}
		}
		stream["realitySettings"] = realitySettings
	}
	// TLS terminates on the node with the operator-supplied cert, embedded
	// inline (no ACME). xray accepts `certificate`/`key` as string arrays.
	if security == "tls" {
		tls := map[string]any{
			"certificates": []map[string]any{
				{
					"certificate": splitPEMLines(cfg.TLSCert),
					"key":         splitPEMLines(cfg.TLSKey),
				},
			},
		}
		if cfg.TLSServerName != "" {
			tls["serverName"] = cfg.TLSServerName
		}
		// B3: harden against SNI probing. Off by default; omitting the field
		// keeps pre-B3 configs byte-identical.
		if cfg.TLSRejectUnknownSni {
			tls["rejectUnknownSni"] = true
		}
		stream["tlsSettings"] = tls
	}

	switch network {
	case "raw", "":
		// nothing extra, REALITY+Vision canonical
	case "ws":
		ws := map[string]any{"path": path}
		if cfg.HostHeader != "" {
			ws["headers"] = map[string]any{"Host": cfg.HostHeader}
		}
		stream["wsSettings"] = ws
	case "xhttp":
		// B3: mode from the panel; empty falls back to "auto" so pre-B3 configs
		// render identically.
		mode := cfg.XhttpMode
		if mode == "" {
			mode = "auto"
		}
		xh := map[string]any{"path": path, "mode": mode}
		if cfg.HostHeader != "" {
			xh["host"] = cfg.HostHeader
		}
		// B3: request padding blurs the packet-size signature under DPI. Empty
		// (default) omits `extra`, keeping the render byte-stable.
		if cfg.XhttpPaddingBytes != "" {
			xh["extra"] = map[string]any{"xPaddingBytes": cfg.XhttpPaddingBytes}
		}
		stream["xhttpSettings"] = xh
	case "httpupgrade":
		hu := map[string]any{"path": path}
		if cfg.HostHeader != "" {
			hu["host"] = cfg.HostHeader
		}
		stream["httpupgradeSettings"] = hu
	case "grpc":
		stream["grpcSettings"] = map[string]any{
			"serviceName": cfg.ServiceName,
			// B3: multiMode from the panel; default false matches pre-B3 render.
			"multiMode": cfg.GrpcMultiMode,
		}
	case "kcp":
		// mKCP is UDP-based; collides with Hysteria on the same UDP port,
		// the panel-side schema validation should reject overlap when
		// creating an inbound on a node that already has a Hysteria inbound
		// using the same port. We don't enforce that here (one node →
		// possibly multiple adapters → cross-adapter awareness lives on
		// the panel side).
		stream["kcpSettings"] = map[string]any{
			"mtu":              1350,
			"tti":              50,
			"uplinkCapacity":   100,
			"downlinkCapacity": 100,
			"congestion":       false,
			"readBufferSize":   2,
			"writeBufferSize":  2,
			"header":           map[string]any{"type": "none"},
		}
	}
	return stream
}

// buildWarpOutbound renders the Cloudflare WARP wireguard outbound (tag "warp").
// PublicKey/Endpoint/MTU fall back to Cloudflare's well-known defaults; reserved
// (the account client_id, 3 bytes) is emitted only when present - required in
// some regions, harmless elsewhere. Per docs/studies/STUDY-warp-native.md.
func buildWarpOutbound(w *WarpConfig) map[string]any {
	pub := w.PublicKey
	if pub == "" {
		pub = warpDefaultPublicKey
	}
	endpoint := w.Endpoint
	if endpoint == "" {
		endpoint = warpDefaultEndpoint
	}
	mtu := w.MTU
	if mtu == 0 {
		mtu = warpDefaultMTU
	}
	settings := map[string]any{
		"secretKey": w.SecretKey,
		"address":   w.Address,
		"peers": []map[string]any{{
			"publicKey":  pub,
			"allowedIPs": []string{"0.0.0.0/0", "::/0"},
			"endpoint":   endpoint,
		}},
		"mtu": mtu,
	}
	if len(w.Reserved) == 3 {
		settings["reserved"] = w.Reserved
	}
	return map[string]any{
		"protocol": "wireguard",
		"tag":      "warp",
		"settings": settings,
	}
}

// validateConfig asks the core itself whether it would load this config, by
// running `xray -test -c` against a copy in a temp dir.
//
// Why the core and not our own checks: xray answers a rejected config by
// refusing ALL of it, not the offending part. One bad field takes down the
// user inbounds too, so a node that was serving fine goes dark. Nothing we can
// assert about the JSON ourselves is the same question as "will it start", and
// on 2026-08-15 that difference cost a live cascade both of its entries for
// hours: the panel sent a balancer with no observatory, the agent wrote it over
// the working config, and the core then crash-looped until its restart budget
// ran out.
//
// The check runs against the operator's own binary, which is the point. The
// panel validates its fragments in CI, but with OUR pinned xray; the node may
// run a different build, and it is the node's core that has to accept it.
//
// An empty binary path (config-only mode) skips the check: there is nothing to
// ask, and nothing will be started either.
func validateConfig(ctx context.Context, run RunCmdFunc, binary string, blob []byte) error {
	if binary == "" || run == nil {
		return nil
	}
	dir, err := os.MkdirTemp("", "iceslab-xray-test-")
	if err != nil {
		return fmt.Errorf("temp dir for config test: %w", err)
	}
	defer os.RemoveAll(dir)
	candidate := filepath.Join(dir, "config.json")
	if err := os.WriteFile(candidate, blob, 0o600); err != nil {
		return fmt.Errorf("write candidate config: %w", err)
	}
	out, err := run(ctx, binary, "-test", "-c", candidate)
	if err != nil {
		// The core's own words, trimmed: they name the offending part, and this
		// message is what an operator will read in the agent's journal.
		return fmt.Errorf("core rejected the config: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// writeConfig atomically writes the config to disk via the shared
// atomicfile helper (fsync(file)+fsync(dir)). xray never sees a
// half-written config even if Restart races the writer or the box
// power-cycles right after the rename.
func writeConfig(path string, blob []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return atomicfile.Write(path, blob, 0o600)
}
