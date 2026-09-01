// Package core hosts the CoreAdapter abstraction that every protocol-specific
// adapter (Hysteria, Xray, AmneziaWG, NaiveProxy) implements.
package core

import "time"

// User is the normalized form of dto.AddUserRequest. The dispatcher copies
// only the protocol-specific credentials each adapter cares about, the rest
// are zero-valued and ignored.
type User struct {
	UserID   string
	ShortID  string
	Username string

	HysteriaPassword   string
	XrayUUID           string
	NaivePassword      string
	AmneziaWGPublicKey string
	AmneziaWGAllowedIP string
	// Plain WireGuard reuses the same user keypair as AmneziaWG but gets its
	// own allocated tunnel IP, because the two inbounds carry separate
	// subnets. A node bound to both profiles receives both addresses.
	WireguardPublicKey string
	WireguardAllowedIP string
	// Optional preshared key per flavour. Empty = the peer gets no
	// PresharedKey line, the behaviour every config predating this field
	// relies on.
	AmneziaWGPresharedKey string
	WireguardPresharedKey string
	TuicUUID              string
	TuicPassword          string
	AnytlsPassword        string
	ShadowtlsPassword     string
	// MtprotoSecret is the user's own MTProto secret (32 hex chars). Only set
	// for the mtprotoproxy engine; mtg derives its single secret from the
	// inbound and ignores this.
	MtprotoSecret string
	// MtprotoExpiresAt is zero when the user has no expiry. MtprotoQuotaBytes
	// is zero for unlimited. Both are backstops the mtprotoproxy engine applies
	// locally; the panel is what actually removes an expired or over-quota user.
	MtprotoExpiresAt  time.Time
	MtprotoQuotaBytes int64
}

// AbusePolicy (U4) selects which built-in anti-abuse routing rules a core
// renders. It is shared by every core that emits them (xray and shadowsocks
// both render an xray routing section) so one profile toggle cannot mean two
// different things depending on which core serves it.
//
// A nil *AbusePolicy means "all enabled", the historical hardcoded behaviour,
// which is why every accessor below is written to work on a nil receiver: the
// renderers ask the policy what to block instead of re-deriving the
// nil-means-defaults rule each time.
//
// The json tags let this type double as the panel-pushed wire shape (the
// `abusePolicy` object on XrayInboundCfg / ShadowsocksInboundCfg in
// packages/shared/src/transport.ts). All three flags are always present when
// the object is sent (the panel schema defaults each to true), so a non-nil
// pointer carries a fully-specified policy.
type AbusePolicy struct {
	BlockTorrent   bool `json:"blockTorrent"`
	BlockSmtp      bool `json:"blockSmtp"`
	BlockDnsHijack bool `json:"blockDnsHijack"`
}

// BlocksTorrent reports whether BitTorrent traffic routes to the blackhole.
func (p *AbusePolicy) BlocksTorrent() bool { return p == nil || p.BlockTorrent }

// BlocksSmtp reports whether outbound port-25 traffic routes to the blackhole.
func (p *AbusePolicy) BlocksSmtp() bool { return p == nil || p.BlockSmtp }

// BlocksDnsHijack reports whether DNS-protocol traffic is pinned to dns-out so
// the upstream resolver never sees the client's real IP.
func (p *AbusePolicy) BlocksDnsHijack() bool { return p == nil || p.BlockDnsHijack }

// Equal reports whether two policies render the same rules, so an adapter can
// skip a restart when the policy did not actually change. A nil policy and an
// explicit all-true policy render identically but are NOT equal here: the
// difference is what the panel sent, and an adapter that swallowed it would
// keep stale flags after the operator cleared the object.
func (p *AbusePolicy) Equal(other *AbusePolicy) bool {
	if p == nil || other == nil {
		return p == other
	}
	return *p == *other
}

// UserStats are per-user traffic counters reported by a single core.
type UserStats struct {
	UserID   string
	BytesIn  int64
	BytesOut int64
}

// Stats is what an adapter returns from GetStats. The aggregator in
// `internal/server` merges Stats from all running adapters into the
// dto.GetStatsResponse the panel sees.
type Stats struct {
	Users         []UserStats
	TotalBytesIn  int64
	TotalBytesOut int64
	// Cumulative reports whether Users[] counters are cumulative-since-core-start
	// (so the panel computes per-poll deltas against a stored snapshot) rather
	// than already-deltas-since-last-poll. Xray reports cumulative via a
	// non-destructive read; panels that don't see this flag use the legacy
	// delta path. #5.
	Cumulative bool
	// Degraded reports that this adapter could NOT read its counters this poll,
	// so Users[] is missing rows rather than reporting them as zero.
	//
	// It exists because "said nothing" and "said zero" are the same thing to the
	// panel: it sums a user's cumulative rows across adapters before comparing
	// the sum to its snapshot, so one adapter dropping out reads as a counter
	// reset, re-baselines the snapshot low, and makes the next successful poll
	// bill that adapter's whole since-core-start counter in one go. Measured
	// live 2026-08-30 on a node running xray and sing-box: one blocked poll on
	// sing-box's stats endpoint, no traffic at all, +516 083 bytes on the user -
	// exactly sing-box's cumulative.
	//
	// Emitting no rows (what xray already did) does not avoid this. Only the
	// node can tell the two apart, so the node says so and the panel leaves its
	// snapshots alone for that poll; nothing is lost, because the read is
	// non-destructive and the next poll's delta still covers the gap.
	Degraded bool
}
