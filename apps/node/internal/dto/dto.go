// Package dto contains JSON wire-format structs for the panel↔node API.
// Field names match the TypeScript DTOs in `packages/shared/src/transport.ts`.
package dto

import "encoding/json"

// ProtocolName mirrors the union in shared/transport.ts.
type ProtocolName string

const (
	ProtocolHysteria    ProtocolName = "hysteria"
	ProtocolXray        ProtocolName = "xray"
	ProtocolAmneziaWG   ProtocolName = "amneziawg"
	ProtocolNaive       ProtocolName = "naive"
	ProtocolShadowsocks ProtocolName = "shadowsocks"
	ProtocolTuic        ProtocolName = "tuic"
	ProtocolAnytls      ProtocolName = "anytls"
	ProtocolShadowtls   ProtocolName = "shadowtls"
)

// EngineName identifies the proxy core that renders an inbound. Most protocols
// have a single native core; the shared protocols can additionally be served
// by the sing-box engine (engine-choice).
type EngineName string

const (
	EngineXray     EngineName = "xray"
	EngineHysteria EngineName = "hysteria"
	EngineSingbox  EngineName = "singbox"
)

// NativeEngine returns the default core for a protocol when an inbound does not
// pin an explicit engine. Shadowsocks runs on xray-core; tuic/anytls are
// singbox-only; every other protocol's native core shares the protocol's name.
func NativeEngine(p ProtocolName) EngineName {
	switch p {
	case ProtocolShadowsocks:
		return EngineXray
	case ProtocolTuic, ProtocolAnytls, ProtocolShadowtls:
		return EngineSingbox
	default:
		return EngineName(p)
	}
}

type ProtocolCredentials struct {
	HysteriaPassword   string `json:"hysteriaPassword,omitempty"`
	XrayUUID           string `json:"xrayUuid,omitempty"`
	NaivePassword      string `json:"naivePassword,omitempty"`
	AmneziaWGPublicKey string `json:"amneziawgPublicKey,omitempty"`
	// AmneziaWGAllowedIP is the IP the panel allocated for this user inside
	// the inbound's subnet (e.g. "10.0.0.42"). The adapter writes it into
	// the peer block as `<ip>/32`. Only present when the user has access to
	// an amneziawg inbound.
	AmneziaWGAllowedIP string `json:"amneziawgAllowedIp,omitempty"`
	// TUIC (sing-box engine): per-user UUID + password. Both required for a
	// TUIC v5 client to authenticate. Only present when the user has access
	// to a tuic inbound.
	TuicUUID     string `json:"tuicUuid,omitempty"`
	TuicPassword string `json:"tuicPassword,omitempty"`
	// AnyTLS (sing-box engine): per-user password (password-only auth).
	AnytlsPassword string `json:"anytlsPassword,omitempty"`
	// ShadowTLS (sing-box engine): per-user password for the shadowtls v3
	// users[] (the inner shadowsocks key is server-wide, in the inbound config).
	ShadowtlsPassword string `json:"shadowtlsPassword,omitempty"`
}

// ───── POST /addUser ─────

type AddUserRequest struct {
	UserID      string              `json:"userId"`
	ShortID     string              `json:"shortId"`
	Username    string              `json:"username"`
	Credentials ProtocolCredentials `json:"credentials"`
}

type AddUserResponse struct {
	OK bool `json:"ok"`
}

// ───── POST /applyInbounds ─────
//
// Panel pushes the FULL set of enabled inbounds bound to this node. Slice 24:
// replaces the env-var workflow (XRAY_REALITY_*, /etc/hysteria/config.yaml
// hand-edits) caught as friction during the 2026-05-06 VPS test.
//
// The Config field is intentionally raw JSON: each adapter decodes only the
// shape that matches its protocol. Keeps the dto layer protocol-agnostic and
// avoids forcing every node-agent build to know every protocol's schema.

type InboundDto struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Protocol ProtocolName `json:"protocol"`
	// Engine pins the proxy core that renders this inbound. Empty -> the
	// protocol's NativeEngine. Lets a shared protocol (vless/vmess/trojan/ss/
	// hy2) be served by the sing-box engine instead of its native core.
	Engine EngineName      `json:"engine,omitempty"`
	Port   int             `json:"port"`
	Config json.RawMessage `json:"config"`
}

// ResolvedEngine returns the inbound's pinned engine, falling back to the
// protocol's native core when none is set (backward-compat: inbounds created
// before engine-choice carry no engine field).
func (i InboundDto) ResolvedEngine() EngineName {
	if i.Engine != "" {
		return i.Engine
	}
	return NativeEngine(i.Protocol)
}

type ApplyInboundsRequest struct {
	Inbounds []InboundDto `json:"inbounds"`
}

type ApplyInboundsResponse struct {
	OK      bool `json:"ok"`
	Applied int  `json:"applied"`
	Skipped int  `json:"skipped"`
}

// ───── POST /applyEgress ─────
//
// B2 - zapret2 egress-desync policy. Mirrors ApplyEgressRequest/Response in
// packages/shared/src/transport.ts (wire-sync: json tags match exactly).
// Config is the fully-resolved zapret2 `config` file body (the panel renders
// preset + overrides; the node just writes it). Enabled=false tears it down.

type ApplyEgressRequest struct {
	Enabled bool   `json:"enabled"`
	Config  string `json:"config"`
	// Strategy (B2b) is a TLS bypass strategy the panel picked for this node,
	// typically one another node on the same AS found for itself. It is a SEED:
	// this node's own scan, when it has one, always wins, because that one was
	// measured here. Empty = nothing suggested.
	Strategy string `json:"strategy,omitempty"`
}

type ApplyEgressResponse struct {
	OK      bool `json:"ok"`
	Applied bool `json:"applied"`
}

// ───── POST /generateKeys ─────
//
// U5 - mint key material with the core binary that will use it. Mirrors
// GenerateKeysRequest/Response in packages/shared/src/transport.ts.
// `raw` is the subcommand's stdout verbatim; the panel parses it, and shows it
// as-is when it cannot (see the KeyGenerator interface for why the node does
// not parse).

type GenerateKeysRequest struct {
	// Kind is the core's own keygen subcommand ("mldsa65", "vlessenc").
	Kind string `json:"kind"`
}

type GenerateKeysResponse struct {
	OK   bool   `json:"ok"`
	Kind string `json:"kind"`
	Raw  string `json:"raw"`
}

// ───── POST /removeUser ─────

type RemoveUserRequest struct {
	UserID string `json:"userId"`
}

type RemoveUserResponse struct {
	OK bool `json:"ok"`
}

// ───── GET /stats ─────

type UserStats struct {
	UserID   string `json:"userId"`
	BytesIn  int64  `json:"bytesIn"`
	BytesOut int64  `json:"bytesOut"`
	// Cumulative=true means THIS user's counters are cumulative-since-core-start
	// (the producing adapter does a non-destructive read: xray / sing-box); false
	// or omitted means they are already per-poll deltas (awg / hysteria / ss /
	// mtproto). Set per-user so a node running BOTH a cumulative and a delta core
	// reports each user correctly. Previously only the response-level Cumulative
	// below existed, so a mixed node OR'd to true and the panel snapshot-deltaed
	// the delta-core users down to ~zero (traffic under-count). Older panels
	// ignore this field and fall back to the response-level flag.
	Cumulative bool `json:"cumulative,omitempty"`
}

type GetStatsResponse struct {
	Users         []UserStats `json:"users"`
	Uptime        int64       `json:"uptime"`
	TotalBytesIn  int64       `json:"totalBytesIn"`
	TotalBytesOut int64       `json:"totalBytesOut"`
	// Cumulative=true means Users[] counters are cumulative-since-core-start and
	// the panel must compute deltas against its stored snapshot. Absent/false
	// keeps the legacy "already-deltas" interpretation for older agents. #5.
	Cumulative bool `json:"cumulative,omitempty"`
}

// ───── GET /healthz ─────

// CoreRestartsDto is the per-core restart tally (2026-08-04). Omitted entirely
// by adapters that don't supervise a subprocess and by pre-2026-08 agents, so
// the panel must treat its absence as "unknown", not as "zero restarts".
type CoreRestartsDto struct {
	// Core names which core these numbers belong to ("xray", ...). Present so a
	// reader never has to infer it from the node's protocol: today only xray
	// arms the watchdog, but the mechanism is core-agnostic.
	Core string `json:"core"`
	// Total is Crash+Memory, sent explicitly so a reader doesn't have to know
	// the breakdown is exhaustive (a future third cause would keep Total right
	// while crash+memory silently stopped adding up).
	Total  int `json:"total"`
	Crash  int `json:"crash"`
	Memory int `json:"memory"`
	// LastAt is RFC3339, empty when nothing has restarted yet.
	LastAt string `json:"lastAt,omitempty"`
	// LastReason is "crash" or "memory" (subprocess.RestartReason), empty until
	// something restarts.
	LastReason string `json:"lastReason,omitempty"`
	// SinceAt (RFC3339) is when the agent started counting. Counters are
	// in-memory, so they reset when the agent restarts; without this a bare
	// "3 restarts" can't be dated.
	SinceAt string `json:"sinceAt,omitempty"`
	// MemoryLimitBytes is the armed ceiling; 0 means the watchdog is off.
	// RssBytes is the latest sample (0 = not sampled / not supported).
	MemoryLimitBytes uint64 `json:"memoryLimitBytes,omitempty"`
	RssBytes         uint64 `json:"rssBytes,omitempty"`
}

type CoreStatus struct {
	Name    ProtocolName `json:"name"`
	Running bool         `json:"running"`
	// Restarts is present only for cores that supervise a real process. See
	// CoreRestartsDto: absent means "this agent/core doesn't report", which is
	// NOT the same as zero.
	Restarts *CoreRestartsDto `json:"restarts,omitempty"`
	// Version is the underlying core binary version (e.g. "26.3.27" from
	// `xray version`), empty when the adapter can't report one. The panel
	// stores it per node to gate features needing a minimum core version
	// (exit selection needs xray >= 25.9.5). Optional/omitempty so pre-T7
	// agents and non-versioned cores stay wire-compatible.
	Version string `json:"version,omitempty"`
	// Provisioned tells "this core has a config and should be running" apart
	// from "nobody has configured this core yet". The installer registers an
	// adapter for every protocol the operator might switch on later, so an
	// idle core is the normal state of a healthy node, not a fault.
	//
	// Pointer + omitempty on purpose: absent means the agent is older than the
	// field, which is NOT the same as false. A panel reading absent must assume
	// configured, the behaviour that predates it.
	Provisioned *bool `json:"provisioned,omitempty"`
}

// EgressTuneDto (F3) is the DPI-bypass strategy this node found for itself and
// is currently running. Reported so an operator can see WHICH strategy a node
// settled on, compare nodes on the same uplink, and promote a winner into a
// vendored preset later. Absent on a node that never scanned, whose scan found
// nothing, or that runs a pre-F3 agent, which are three different things the
// counts below tell apart.
type EgressTuneDto struct {
	Domain   string  `json:"domain"`
	Protocol string  `json:"protocol"`
	Args     string  `json:"args"`
	Coverage float64 `json:"coverage,omitempty"`
	Total    int     `json:"total"`
	Working  int     `json:"working"`
}

type HealthcheckResponse struct {
	Status string       `json:"status"`
	Cores  []CoreStatus `json:"cores"`
	// F3: the self-tuned egress strategy, when this node runs one.
	EgressTune *EgressTuneDto `json:"egressTune,omitempty"`
}

// ───── GET /metrics ─────
//
// Host-level CPU / memory / disk for the VPS the node-agent runs on. Polled
// by the panel every 15s and cached in Redis with TTL 60s, so the dashboard
// can show per-node load without paying mTLS round-trip on every page open.

type CPUMetricsDto struct {
	UsagePercent float64 `json:"usagePercent"`
	LoadAvg1     float64 `json:"loadAvg1"`
	LoadAvg5     float64 `json:"loadAvg5"`
	LoadAvg15    float64 `json:"loadAvg15"`
	Cores        int     `json:"cores"`
}

type MemoryMetricsDto struct {
	TotalBytes     uint64  `json:"totalBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

type DiskMetricsDto struct {
	Path        string  `json:"path"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type HostMetricsResponse struct {
	CPU           CPUMetricsDto    `json:"cpu"`
	Memory        MemoryMetricsDto `json:"memory"`
	Disk          DiskMetricsDto   `json:"disk"`
	UptimeSeconds int64            `json:"uptimeSeconds"`
	CollectedAt   string           `json:"collectedAt"`
}

// ───── GET /ufwPorts ─────
//
// G4 probe-exposure: the agent reports the ufw-allowed inbound ports so the
// panel can compare them to the expected set (binding ports + SSH + mTLS port)
// and warn the operator about anything unexpected left open to the internet.

type UfwPortDto struct {
	Port  int    `json:"port"`
	Proto string `json:"proto"` // "tcp" | "udp"
}

type UfwPortsResponse struct {
	// Managed=false means ufw is not installed on the host; the panel skips
	// the exposure check rather than treating it as an error.
	Managed bool         `json:"managed"`
	Ports   []UfwPortDto `json:"ports"`
}

// ───── Common error shape ─────

type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}
