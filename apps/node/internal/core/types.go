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
	// AmneziaWGAllowedIP3: the address on the 3.1 interface (t07-6).
	AmneziaWGAllowedIP3 string
	TuicUUID            string
	TuicPassword        string
	AnytlsPassword      string
	ShadowtlsPassword   string
	// MtprotoSecret is the user's own MTProto secret (32 hex chars), for the
	// mtprotoproxy engine only; mtg has one secret per inbound and ignores it.
	MtprotoSecret string
	// MtprotoExpiresAt is the user's term, the zero time for none. A backstop:
	// the adapter cuts the user off at this instant when the panel cannot.
	MtprotoExpiresAt time.Time
	// MtprotoQuotaBytes is what is left of the user's traffic limit, nil for no
	// limit (0 is exhausted). A backstop as well: the panel's accounting is the
	// primary one, and the engine counts only its own traffic.
	MtprotoQuotaBytes *int64

	// Plain WireGuard (milestone 9.1): the same keypair as AmneziaWG, and an
	// address of its own from the plain profile's subnet.
	WireguardPublicKey string
	WireguardAllowedIP string

	// AmneziaWGPeers: one peer per device of the user (milestone 9.4), each
	// with its own key and an address per interface. Non-nil replaces the
	// single fields above, which an older panel sends instead; non-nil and
	// empty means no device, no peer. Both flavours take their peer from it.
	AmneziaWGPeers []AmneziaWGPeer
}

// AmneziaWGPeer is one device of a user: its key and its address on each
// interface kind. An address may be empty: the profile of that kind does not
// reach the user.
type AmneziaWGPeer struct {
	PublicKey string
	// AllowedIP on the 1.x interface, AllowedIP3 on the 3.1 one, WireguardAllowedIP
	// on the plain WireGuard one.
	AllowedIP          string
	AllowedIP3         string
	WireguardAllowedIP string
	// The device's preshared key on each interface kind (milestone 9.5), empty
	// where that interface's profile does not ask for one. The panel sends the
	// one secret of the device to every interface whose profile has the flag on.
	PresharedKey          string
	PresharedKey3         string
	WireguardPresharedKey string
}

// UserStats are per-user traffic counters reported by a single core.
type UserStats struct {
	UserID   string
	BytesIn  int64
	BytesOut int64
	// Peers: the same counters by peer key, for a core whose user holds a peer
	// per device (AmneziaWG and plain WireGuard, milestone 9.6). Their sum is
	// BytesIn/BytesOut. Nil for a core that keeps none.
	Peers []PeerStats
}

// PeerStats are one peer's counters, in the same mode as its user's entry.
type PeerStats struct {
	PublicKey string
	BytesIn   int64
	BytesOut  int64
	// LastHandshake: unix seconds of the peer's latest handshake, 0 for never
	// (or since the interface was last created).
	LastHandshake int64
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
	// NoData: the core was asked and did not answer this poll. Users and the
	// totals are then absent, not zero (A-163, 22.10): zeros from a missed
	// poll read as a cumulative counter dropping to 0, the panel re-baselined
	// the user's snapshot, and the next good poll billed the whole counter at
	// once. A core that is not running and so was not asked is not NoData.
	NoData bool
	// Lingering (A-218): users this core no longer holds whose connections
	// are still open, by the email the core knows them by. Nil when the core
	// was not asked or did not answer: "not known", never "nobody"; an empty
	// non-nil slice is "asked, nobody".
	Lingering []LingeringUser
}

// LingeringUser is one such user and how many connections they still hold.
type LingeringUser struct {
	Email    string
	Sessions int64
}
