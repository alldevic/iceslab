package amneziawg

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

const (
	// Name is the AmneziaWG protocol, the package's original and default mode.
	Name = "amneziawg"
	// NameWireguard is upstream WireGuard: the same interface lifecycle driven
	// through `wg` / `wg-quick`, with no obfuscation directives rendered, so
	// stock WireGuard clients (the official apps, WireSock, kernel wg) can
	// complete a handshake. AmneziaWG deliberately cannot serve them: its
	// magic headers H1-H4 must differ from WireGuard's 1..4.
	NameWireguard = "wireguard"
)

// defaultInterface is the device name a flavour claims when the installer
// didn't pin one. Distinct per flavour so a node running both never has two
// adapters fighting over one device.
func defaultInterface(protocol string) string {
	if protocol == NameWireguard {
		return "wg0"
	}
	return "awg0"
}

// defaultConfigPath mirrors where each flavour's tooling looks by default:
// wg-quick reads /etc/wireguard/<iface>.conf, awg-quick /etc/amnezia/amneziawg.
func defaultConfigPath(protocol, iface string) string {
	if protocol == NameWireguard {
		return fmt.Sprintf("/etc/wireguard/%s.conf", iface)
	}
	return fmt.Sprintf("/etc/amnezia/amneziawg/%s.conf", iface)
}

// unitName is the systemd unit that owns the interface, used for the restart
// fallback when syncconf fails.
func (a *Adapter) unitName(iface string) string {
	if a.plain() {
		return "wg-quick@" + iface
	}
	return "awg-quick@" + iface
}

const defaultSyncTimeout = 10 * time.Second

// Config is the per-instance settings for an AmneziaWGAdapter.
type Config struct {
	// Protocol selects which member of the wg-quick family this instance
	// serves: "amneziawg" (default) or "wireguard". The two share every line
	// of peer management, stats and reload logic and differ only in the
	// obfuscation block of the rendered config, the CLI names, and the
	// systemd unit, so one adapter serves both, the way the sing-box adapter
	// serves tuic/anytls/shadowtls. A node running both gets two instances,
	// each on its own interface, config path and UDP port.
	Protocol string

	// Inbound is the static interface settings (keys, ports, obfuscation).
	// Slice 23 will move these into the inbounds table per node.
	Inbound InboundConfig

	// ConfigPath is where awg-quick / awg syncconf read the interface config
	// from. Default "/etc/amnezia/amneziawg/<iface>.conf".
	ConfigPath string

	// AwgBin / AwgQuickBin / SystemctlBin are CLI paths (`wg` / `wg-quick`
	// when Protocol is "wireguard"). When AwgQuickBin is
	// empty the adapter runs in **config-only mode**: it writes the config
	// file but never invokes any CLI. That mode is what tests and dev
	// environments without amneziawg installed use.
	AwgBin       string
	AwgQuickBin  string
	SystemctlBin string

	// SyncTimeout caps how long `awg syncconf` may run before we bail out
	// and trigger the systemctl-restart fallback. Default 10s.
	//
	// The fallback exists because we've seen `awg syncconf` hang on a known
	// kernel-module bug; without a timeout the panel queue would stall.
	SyncTimeout time.Duration

	// runCmd is an injection point for tests. nil → real exec.CommandContext.
	runCmd func(ctx context.Context, name string, args ...string) ([]byte, error)
}

// Adapter implements core.CoreAdapter for AmneziaWG.
type Adapter struct {
	cfg    Config
	logger *slog.Logger

	// restartMu serializes the slow config IO (awg-quick up/down, `awg
	// syncconf`, systemctl restart) so at most one reload runs at a time. mu
	// guards only the in-memory state below and is NEVER held across a CLI
	// fork. Lock order is always restartMu -> mu; no path upgrades mu to
	// restartMu, so the two can't deadlock (AWG#10).
	restartMu sync.Mutex
	mu        sync.Mutex
	peers     map[string]Peer // key: userId
	started   bool
	// lastStats holds the previous cumulative kernel counters per peer, keyed
	// by PublicKey to match `awg show dump`. GetStats diffs against it so the
	// panel ingests per-poll DELTAS (the same contract the xray adapter meets
	// via `statsquery -reset`). Rebuilt every poll: a pubkey's absence means
	// "first sight" (fresh agent start or just-added peer) and reports zero, so
	// an agent restart over a still-up interface never re-bills the lifetime.
	lastStats map[string]peerCounters

	// inboundID is which inbound the panel last pushed here, as the panel names
	// it. "" means nothing identified has ever arrived: either an install-time
	// interface nobody has bound a profile to, or a panel too old to send the
	// field. Both keep the pre-reconciliation behaviour, because there is nothing
	// to reconcile against.
	inboundID string

	// N3 - cached `awg show` health probe (guarded by mu). Healthy() serves
	// healthResult and refreshes in the background once older than
	// healthProbeTTL, so the hot health path never forks the CLI inline.
	healthCheckedAt time.Time
	healthResult    bool
	healthProbing   bool
}

type peerCounters struct {
	rx int64
	tx int64
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.Protocol == "" {
		cfg.Protocol = Name
	}
	plain := cfg.Protocol == NameWireguard
	// The renderer keys off the inbound, not the adapter, so stamp the mode
	// here: every later path (Start, ApplyInbound) rebuilds InboundConfig from
	// the wire and must inherit it.
	cfg.Inbound.Plain = plain
	if cfg.Inbound.Interface == "" {
		cfg.Inbound.Interface = defaultInterface(cfg.Protocol)
	}
	if cfg.ConfigPath == "" {
		cfg.ConfigPath = defaultConfigPath(cfg.Protocol, cfg.Inbound.Interface)
	}
	if cfg.SyncTimeout == 0 {
		cfg.SyncTimeout = defaultSyncTimeout
	}
	if cfg.runCmd == nil {
		cfg.runCmd = realRunCmd
	}
	return &Adapter{
		cfg:       cfg,
		logger:    logger,
		peers:     make(map[string]Peer),
		lastStats: make(map[string]peerCounters),
	}
}

func realRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	return out, err
}

func (a *Adapter) Name() string { return a.cfg.Protocol }

// Engine reports the native proxy core (neither wg flavour has an alternate
// engine, so the engine name is the protocol name).
func (a *Adapter) Engine() string { return a.cfg.Protocol }

// plain reports whether this instance serves upstream WireGuard rather than
// AmneziaWG. Derived from Protocol so the two can never disagree.
func (a *Adapter) plain() bool { return a.cfg.Protocol == NameWireguard }

// Start writes the initial (no-peer) config and brings the awg interface up.
// In config-only mode (AwgQuickBin == "") it just writes the config.
//
// Special case: on a freshly-bootstrapped node, main.go can only fill in the
// interface name and bin paths, every other field (PrivateKey, Address,
// H1-H4, S1-S4, Jc/Jmin/Jmax) lives in panel-side `Profile.config` and only
// arrives via the first `ApplyInbound` over mTLS. Calling `renderConfig`
// here would fail validation with "PrivateKey is required" and crash the
// agent in a loop. Detect that empty-config state and *defer* the bring-up
// until ApplyInbound supplies real values, that handler already calls
// restartInterfaceLocked which writes the config + awg-quick up and flips
// `started` to true. Caught live cycle #6 2026-05-12 on awg-VPS.
// Provisioned implements core.Provisionable: without a server key the interface
// cannot come up at all. Same condition Start defers on — and now literally the
// same expression: it used to be written out twice, once here and once inline
// in Start, under a comment claiming they could not drift. What that costs if
// they do is a node whose /healthz reports an adapter as provisioned while
// Start silently deferred it, or the reverse.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.provisionedLocked()
}

// provisionedLocked is the condition itself. Callers hold a.mu.
func (a *Adapter) provisionedLocked() bool { return a.cfg.Inbound.PrivateKey != "" }

func (a *Adapter) Start(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	if !a.provisionedLocked() {
		iface := a.cfg.Inbound.Interface
		a.mu.Unlock()
		a.logger.Info("adapter deferred, awaiting first ApplyInbound from panel",
			"core", a.cfg.Protocol, "interface", iface)
		return nil
	}
	inbound := a.cfg.Inbound
	peers := sortedPeers(a.peers)
	managed := a.cfg.AwgQuickBin != ""
	a.mu.Unlock()

	if err := a.writeConfigSnapshot(inbound, peers); err != nil {
		return err
	}

	if managed {
		if out, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "up", inbound.Interface); err != nil {
			// awg-quick up is idempotent-ish, failing because the iface is
			// already up is fine. Anything else is a real error.
			if !strings.Contains(strings.ToLower(string(out)), "already exists") {
				return fmt.Errorf("awg-quick up %s failed: %w (%s)", inbound.Interface, err, strings.TrimSpace(string(out)))
			}
		}
	}

	a.setStarted(true)
	a.logger.Info("adapter started",
		"core", a.cfg.Protocol,
		"interface", inbound.Interface,
		"managed", managed)
	return nil
}

// Stop tears the interface down. Safe to call multiple times.
func (a *Adapter) Stop(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	a.started = false
	managed := a.cfg.AwgQuickBin != ""
	iface := a.cfg.Inbound.Interface
	a.mu.Unlock()

	if !managed {
		return nil
	}
	if _, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "down", iface); err != nil {
		// "iface not running" is expected on a clean stop after a failed start
		a.logger.Warn("awg-quick down returned non-zero (often safe)", "err", err)
	}
	return nil
}

// setStarted flips the started flag under mu. Helper so the IO paths (which run
// without mu held) can record readiness without re-deriving the lock dance.
func (a *Adapter) setStarted(v bool) {
	a.mu.Lock()
	a.started = v
	a.mu.Unlock()
}

// AddUser registers / updates a peer. No-op for users without amneziawg
// credentials. Idempotent.
func (a *Adapter) AddUser(user core.User) error {
	// Both flavours use the user's single WireGuard keypair, but each has its
	// own subnet and therefore its own allocated IP: a node serving both
	// profiles receives two addresses per user and must not cross them.
	pubKey, allowedIP := user.AmneziaWGPublicKey, user.AmneziaWGAllowedIP
	psk := user.AmneziaWGPresharedKey
	if a.plain() {
		pubKey, allowedIP = user.WireguardPublicKey, user.WireguardAllowedIP
		psk = user.WireguardPresharedKey
	}
	if pubKey == "" && allowedIP == "" {
		// Not a wg record at all. The panel fans one credential blob out to every
		// adapter, and a record for another core carries none of these fields.
		return nil
	}
	if pubKey == "" || allowedIP == "" {
		// Half a peer. This used to return nil, so the node answered `ok`, the
		// panel logged the add as done, and no peer existed - the exact shape of
		// the per-user queue's push, which carries a public key and no allocated
		// address because only inbound-sync knows the subnets. A missing half is
		// the panel failing to say something, not a record meant for someone
		// else, and it has to read as a failure.
		missing := "an allocated address"
		if pubKey == "" {
			missing = "a public key"
		}
		return fmt.Errorf("%s AddUser %s: %s is missing, no peer was created",
			a.cfg.Protocol, user.UserID, missing)
	}
	desired := Peer{
		PublicKey: pubKey,
		AllowedIP: ensureCIDR(allowedIP),
		// Part of the comparison below, deliberately: turning preshared keys
		// on or off for a profile changes nothing but this field, and a peer
		// compared without it would be judged unchanged and never re-written.
		PresharedKey: psk,
	}

	a.mu.Lock()
	if existing, ok := a.peers[user.UserID]; ok && existing == desired {
		a.mu.Unlock()
		return nil // no change, no IO
	}
	a.peers[user.UserID] = desired
	a.mu.Unlock()

	// IO runs under restartMu (not mu), re-snapshotting the latest peer set so
	// concurrent Add/Remove calls converge on the final config.
	return a.syncConfigState(context.Background())
}

// RemoveUser drops the peer and reloads the interface. Idempotent.
func (a *Adapter) RemoveUser(userID string) error {
	a.mu.Lock()
	if _, ok := a.peers[userID]; !ok {
		a.mu.Unlock()
		return nil
	}
	delete(a.peers, userID)
	a.mu.Unlock()

	return a.syncConfigState(context.Background())
}

// RetainInbounds implements core.InboundReconciler: when the panel's push no
// longer contains the inbound this adapter holds, take the interface down.
//
// This adapter holds exactly ONE inbound - it does not implement
// core.MultiInbound - and reconciliation is still what removal requires. The
// push carries the node's whole set and is dispatched one inbound at a time, so
// an inbound that vanished produces no call at all; before this, disabling a wg
// binding in the panel simply stopped pushing, and the interface, its peers and
// its UDP port stayed up indefinitely. Measured 2026-08-31: both wg bindings
// disabled, `awg0` and `wg0` still up with every peer, and the only way back was
// `awg-quick down` on the box.
//
// An empty `keep` is the ordinary way that happens (the last wg binding was
// disabled) and is honoured. An adapter that never received an identified
// inbound does nothing: it has nothing to compare, and tearing down an
// install-time interface on a push about other protocols would take a working
// tunnel away for no reason.
func (a *Adapter) RetainInbounds(keep []string) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	id := a.inboundID
	if id == "" {
		a.mu.Unlock()
		return nil
	}
	for _, k := range keep {
		if k == id {
			a.mu.Unlock()
			return nil
		}
	}

	iface := a.cfg.Inbound.Interface
	managed := a.cfg.AwgQuickBin != ""
	peers := len(a.peers)
	// Forget everything the removed inbound brought. The private key going is
	// what makes Provisioned() false again, so /healthz reports this core as
	// unconfigured - the state it was in before the binding existed - instead of
	// as a configured core that has died.
	a.inboundID = ""
	a.peers = make(map[string]Peer)
	a.lastStats = make(map[string]peerCounters)
	a.cfg.Inbound = InboundConfig{
		Interface: iface,
		Plain:     a.plain(),
		PostUp:    a.cfg.Inbound.PostUp,
		PostDown:  a.cfg.Inbound.PostDown,
	}
	a.started = false
	a.healthCheckedAt = time.Time{}
	a.healthResult = false
	a.mu.Unlock()

	a.logger.Info("inbound removed by the panel, taking the interface down",
		"core", a.cfg.Protocol, "inboundId", id, "interface", iface, "peers", peers)

	if !managed {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "down", iface); err != nil {
		// Down on an interface that is not up is the normal outcome of a repeat
		// push, and must not read as a failure - the state we were asked for is
		// the state we are in. The config file is deliberately left on disk: it
		// is what `awg-quick down` reads, so removing it would make a retry
		// impossible, and it holds no access on its own once the interface is
		// gone.
		a.logger.Warn("awg-quick down returned non-zero (often safe)",
			"core", a.cfg.Protocol, "err", err, "out", strings.TrimSpace(string(out)))
	}
	return nil
}

// RetainUsers implements core.UserReconciler: drop every peer the panel no
// longer counts among this node's users.
//
// `addUser` adds and `removeUser` removes one addressed id, so the peer set only
// ever grew towards whatever the panel remembered to mention. A peer is not
// bookkeeping here - it IS the access - so anything the panel failed to name
// (a device deleted while the node was unreachable, a user removed by a job that
// died) kept a working tunnel until someone noticed by hand. `removeUser` on an
// id the adapter does not hold returns nil and is logged as ok, which is why the
// gap could not be seen from the panel at all.
//
// Peers are keyed per DEVICE (inbounds.queue.ts pushes each device under its own
// id), and `keep` carries user ids and device ids together; a user id simply
// matches no peer here.
func (a *Adapter) RetainUsers(keep []string) error {
	keepSet := make(map[string]struct{}, len(keep))
	for _, id := range keep {
		keepSet[id] = struct{}{}
	}

	a.mu.Lock()
	dropped := make([]string, 0)
	for id, peer := range a.peers {
		if _, ok := keepSet[id]; ok {
			continue
		}
		delete(a.peers, id)
		delete(a.lastStats, peer.PublicKey)
		dropped = append(dropped, id)
	}
	remaining := len(a.peers)
	a.mu.Unlock()

	if len(dropped) == 0 {
		return nil
	}
	sort.Strings(dropped)
	a.logger.Info("peers the panel no longer lists, removing",
		"core", a.cfg.Protocol, "dropped", dropped, "remaining", remaining)
	return a.syncConfigState(context.Background())
}

// GetStats parses `awg show <iface> dump` and maps per-peer RX/TX counters
// back to user IDs via the tracked peers.
//
// Kernel counters are CUMULATIVE for the lifetime of the interface, but the
// panel's stats cron treats every adapter's per-user bytes as a delta since
// the last poll (xray meets that contract with `statsquery -reset`). So this
// adapter snapshots the cumulative values (a.lastStats) and emits the per-poll
// DELTA. Without this, the cron re-added each peer's entire lifetime total on
// every tick, endless phantom traffic that drained user quotas (the runaway
// AWG accounting bug, 2026-06-11).
//
// Two edge cases are handled so we never emit a spurious spike:
//   - First sight of a peer (fresh agent start, or peer just added): record the
//     baseline, report zero. An agent restart that leaves the interface up
//     would otherwise re-bill the whole lifetime.
//   - Counter goes backwards (interface bounced via systemctl restart /
//     awg-quick down-up zeroes kernel counters): restart the delta from the
//     current value instead of emitting a negative.
//
// In config-only mode (no AwgBin) returns zero counters per user without
// shelling out, mirroring the old stub behaviour for dev environments
// without amneziawg installed.
func (a *Adapter) GetStats() (*core.Stats, error) {
	// AWG#10 - read what we need under mu, then release it for the `awg show`
	// fork so a slow/hung dump no longer blocks AddUser/RemoveUser. The delta
	// accounting below re-acquires mu and runs verbatim (E4 contract preserved).
	a.mu.Lock()
	configOnly := a.cfg.AwgBin == ""
	iface := a.cfg.Inbound.Interface
	if configOnly {
		users := make([]core.UserStats, 0, len(a.peers))
		for id := range a.peers {
			users = append(users, core.UserStats{UserID: id})
		}
		a.mu.Unlock()
		return &core.Stats{Users: users}, nil
	}
	a.mu.Unlock()

	if iface == "" {
		iface = defaultInterface(a.cfg.Protocol)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := a.cfg.runCmd(ctx, a.cfg.AwgBin, "show", iface, "dump")

	a.mu.Lock()
	defer a.mu.Unlock()

	users := make([]core.UserStats, 0, len(a.peers))
	if err != nil {
		// Interface may be down or never started, fall back to zero counters
		// rather than failing the whole stats poll.
		for id := range a.peers {
			users = append(users, core.UserStats{UserID: id})
		}
		return &core.Stats{Users: users}, nil
	}

	rxByPub, txByPub := parseAwgDump(string(out))

	var totalIn, totalOut int64
	// Rebuild the snapshot from scratch each poll so removed peers drop out and
	// a re-added peer (its kernel counter reset to 0) is treated as first-sight.
	next := make(map[string]peerCounters, len(a.peers))
	for id, peer := range a.peers {
		curRx := rxByPub[peer.PublicKey]
		curTx := txByPub[peer.PublicKey]
		next[peer.PublicKey] = peerCounters{rx: curRx, tx: curTx}

		var dRx, dTx int64
		if last, seen := a.lastStats[peer.PublicKey]; seen {
			if curRx >= last.rx {
				dRx = curRx - last.rx
			} else {
				dRx = curRx // interface bounced, counter reset
			}
			if curTx >= last.tx {
				dTx = curTx - last.tx
			} else {
				dTx = curTx
			}
		}
		// else: first sight, baseline recorded above, count nothing this tick.

		users = append(users, core.UserStats{
			UserID:   id,
			BytesIn:  dRx,
			BytesOut: dTx,
		})
		totalIn += dRx
		totalOut += dTx
	}
	a.lastStats = next

	return &core.Stats{
		Users:         users,
		TotalBytesIn:  totalIn,
		TotalBytesOut: totalOut,
	}, nil
}

// parseAwgDump parses the TSV output of `awg show <iface> dump`. The first
// line is the interface itself; remaining lines are peers in the format:
//
//	<pubkey> <psk> <endpoint> <allowed-ips> <latest-handshake> <rx> <tx> <keepalive>
//
// Returns maps pubkey→rx-bytes and pubkey→tx-bytes. From the server's
// perspective: peer's "rx" is what the server received from the client
// (BytesIn for our user), peer's "tx" is what the server sent back
// (BytesOut for our user). Malformed lines are skipped silently.
func parseAwgDump(dump string) (rx, tx map[string]int64) {
	rx = make(map[string]int64)
	tx = make(map[string]int64)
	lines := strings.Split(strings.TrimSpace(dump), "\n")
	if len(lines) < 2 {
		return
	}
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		pub := fields[0]
		var r, t int64
		if _, err := fmt.Sscanf(fields[5], "%d", &r); err != nil {
			continue
		}
		if _, err := fmt.Sscanf(fields[6], "%d", &t); err != nil {
			continue
		}
		rx[pub] = r
		tx[pub] = t
	}
	return
}

// healthProbeTTL caps how often Healthy() shells out to `awg show`.
const healthProbeTTL = 20 * time.Second

// Healthy reports whether the adapter has finished Start successfully and
// (when managed) the awg interface still exists.
//
// N3 - the probe (`awg show`) can hang on a known kernel-module bug, which
// would block the agent's healthcheck goroutine. So we cache the last probe
// result and refresh it in the BACKGROUND once stale: the request path returns
// the cached value instantly and never forks inline. The very first call
// probes synchronously so we don't report a bogus default before any data.
func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	started := a.started
	managed := a.cfg.AwgQuickBin != ""
	iface := a.cfg.Inbound.Interface
	if !started {
		a.mu.Unlock()
		return false
	}
	if !managed {
		a.mu.Unlock()
		return true
	}

	if a.healthCheckedAt.IsZero() {
		// First probe: synchronous, so the result is real before we return.
		a.mu.Unlock()
		return a.probeHealth(iface)
	}
	if time.Since(a.healthCheckedAt) >= healthProbeTTL && !a.healthProbing {
		// Stale: kick a single background refresh, return the last-known value.
		a.healthProbing = true
		go func() {
			a.probeHealth(iface)
			a.mu.Lock()
			a.healthProbing = false
			a.mu.Unlock()
		}()
	}
	res := a.healthResult
	a.mu.Unlock()
	return res
}

// probeHealth runs `awg show <iface>` and stores the result + timestamp. Bounded
// by a 2s context so a hung CLI can't wedge the caller indefinitely.
func (a *Adapter) probeHealth(iface string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := a.cfg.runCmd(ctx, a.cfg.AwgBin, "show", iface)
	ok := err == nil
	a.mu.Lock()
	a.healthResult = ok
	a.healthCheckedAt = time.Now()
	a.mu.Unlock()
	return ok
}

// ApplyInbound parses panel-pushed AmneziaWG config, classifies the diff vs
// the live cfg.Inbound, and triggers the appropriate reload:
//   - diffNone → no-op
//   - diffSyncconf (S1-S4 / Jc/Jmin/Jmax changed) → rewrite + `awg syncconf`
//   - diffRestart (H1-H4 / private key / port / iface changed) → rewrite +
//     `systemctl restart awg-quick@<iface>` (interface bounces all peers)
//   - diffSubnet (Address from subnet changed) → reject with error when
//     peers are already allocated; admins must drain peers first
//
// Background context for the reload, the inbound HTTP request that triggered
// this may have a short deadline, but we want the interface to come back up
// even if the caller times out (matches the xray adapter pattern).
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	var wire inboundCfgWire
	if err := json.Unmarshal(rawCfg, &wire); err != nil {
		return fmt.Errorf("%s ApplyInbound: parse cfg: %w", a.cfg.Protocol, err)
	}

	// AWG#10 - hold restartMu across the whole apply so a concurrent AddUser
	// sync can't interleave with the interface mutation; mutate + snapshot under
	// mu, then run the reload IO without mu held. Lock order restartMu -> mu.
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	// Remember which inbound this is before anything can return early: the
	// unchanged case returns without touching the config, and an adapter that
	// forgot its id there could not be told the inbound was later removed.
	if wire.InboundID != "" {
		a.inboundID = wire.InboundID
	}
	// Slice 50: prefer the panel-pushed port over install-time fallback.
	// Pre-slice-50 panel paths still work because port=0 falls through to
	// a.cfg.Inbound.ListenPort below.
	listenPort := port
	if listenPort == 0 {
		listenPort = a.cfg.Inbound.ListenPort
	}
	newInbound, err := wire.toInboundConfig(a.cfg.Inbound.Interface, listenPort)
	if err != nil {
		a.mu.Unlock()
		return fmt.Errorf("%s ApplyInbound: %w", a.cfg.Protocol, err)
	}
	// Render mode is adapter identity, not wire content: a plain instance stays
	// plain even if a malformed push carried an obfuscation block (validate()
	// then rejects it rather than silently dropping it).
	newInbound.Plain = a.plain()
	// Preserve install-time PostUp/PostDown and Interface defaults, those
	// aren't in the panel wire. Interface name is install-time identity; if
	// the wire expressed a new one it'd be a separate diffRestart anyway.
	newInbound.PostUp = a.cfg.Inbound.PostUp
	newInbound.PostDown = a.cfg.Inbound.PostDown

	kind := classifyDiff(a.cfg.Inbound, newInbound)
	switch kind {
	case diffNone:
		a.mu.Unlock()
		a.logger.Info("ApplyInbound: config unchanged, skipping", "core", a.cfg.Protocol)
		return nil
	case diffSubnet:
		if len(a.peers) > 0 {
			n := len(a.peers)
			a.mu.Unlock()
			return fmt.Errorf("%s ApplyInbound: subnet change rejected, %d peer(s) already allocated; drain peers before changing subnet", a.cfg.Protocol, n)
		}
		// No peers: subnet change is safe and only needs a full restart to
		// re-attach the new IP to the interface.
		a.cfg.Inbound = newInbound
		inbound := a.cfg.Inbound
		peers := sortedPeers(a.peers)
		a.mu.Unlock()
		a.logger.Info("ApplyInbound: subnet change with no peers, restarting interface",
			"core", a.cfg.Protocol, "address", newInbound.Address)
		return a.restartInterfaceFrom(context.Background(), inbound, peers)
	case diffSyncconf:
		a.cfg.Inbound = newInbound
		inbound := a.cfg.Inbound
		peers := sortedPeers(a.peers)
		a.mu.Unlock()
		a.logger.Info("ApplyInbound: syncconf-eligible change", "core", a.cfg.Protocol, "iface", newInbound.Interface)
		return a.syncFromSnapshot(context.Background(), inbound, peers)
	case diffRestart:
		a.cfg.Inbound = newInbound
		inbound := a.cfg.Inbound
		peers := sortedPeers(a.peers)
		a.mu.Unlock()
		a.logger.Info("ApplyInbound: interface-level change, full restart",
			"core", a.cfg.Protocol, "iface", newInbound.Interface)
		return a.restartInterfaceFrom(context.Background(), inbound, peers)
	default:
		a.mu.Unlock()
		return fmt.Errorf("%s ApplyInbound: unknown diffKind %d", a.cfg.Protocol, kind)
	}
}

// restartInterfaceFrom writes the given config snapshot and bounces the
// interface via awg-quick down/up. Used for changes that syncconf can't apply
// (H1-H4, keys, listen port). Caller MUST hold restartMu and MUST NOT hold mu
// (the awg-quick forks run lock-free; readiness is flipped via setStarted).
//
// In config-only mode (AwgQuickBin == "") we just rewrite the file and skip
// the actual bounce, that's what the unit tests rely on, and what dev
// machines without amneziawg installed need.
func (a *Adapter) restartInterfaceFrom(parent context.Context, inbound InboundConfig, peers []Peer) error {
	if err := a.writeConfigSnapshot(inbound, peers); err != nil {
		return err
	}
	if a.cfg.AwgQuickBin == "" {
		a.logger.Info("restart skipped (config-only mode)", "core", a.cfg.Protocol)
		a.setStarted(true)
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	if out, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "down", inbound.Interface); err != nil {
		// "iface not running" is fine, we're about to bring it up.
		a.logger.Warn("awg-quick down returned non-zero (often safe)",
			"err", err, "out", strings.TrimSpace(string(out)))
	}
	if out, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "up", inbound.Interface); err != nil {
		return fmt.Errorf("awg-quick up %s: %w (%s)", inbound.Interface, err, strings.TrimSpace(string(out)))
	}
	// Mark started so Healthy() returns true and main.go's heartbeat sees
	// a ready adapter after the first ApplyInbound on a freshly-bootstrapped
	// node (Start() returned early because PrivateKey was empty).
	a.setStarted(true)
	a.logger.Info("interface bounced", "core", a.cfg.Protocol, "iface", inbound.Interface)
	return nil
}

// syncConfigState serializes config IO under restartMu, then snapshots the
// CURRENT peer set + inbound under mu and writes + reloads without mu held.
// Used by AddUser/RemoveUser. Concurrent callers converge: whoever runs the IO
// re-reads the latest peers, so no peer is dropped to a stale snapshot.
func (a *Adapter) syncConfigState(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	inbound := a.cfg.Inbound
	peers := sortedPeers(a.peers)
	a.mu.Unlock()

	return a.syncFromSnapshot(ctx, inbound, peers)
}

// syncFromSnapshot writes the given config snapshot and (when managed) reloads
// the running interface via `awg syncconf`, falling back to `systemctl restart
// awg-quick@<iface>` on failure or timeout. Caller MUST hold restartMu and MUST
// NOT hold mu.
func (a *Adapter) syncFromSnapshot(ctx context.Context, inbound InboundConfig, peers []Peer) error {
	if err := a.writeConfigSnapshot(inbound, peers); err != nil {
		return err
	}

	if a.cfg.AwgQuickBin == "" {
		a.logger.Info("config written (config-only mode)", "core", a.cfg.Protocol, "peers", len(peers))
		return nil
	}

	if err := a.syncconf(ctx, inbound.Interface); err != nil {
		a.logger.Warn("awg syncconf failed; falling back to systemctl restart", "err", err)
		return a.restartViaSystemctl(ctx, inbound.Interface)
	}
	a.logger.Info("synced", "core", a.cfg.Protocol, "peers", len(peers))
	return nil
}

func (a *Adapter) syncconf(parent context.Context, iface string) error {
	ctx, cancel := context.WithTimeout(parent, a.cfg.SyncTimeout)
	defer cancel()

	stripped, err := a.cfg.runCmd(ctx, a.cfg.AwgQuickBin, "strip", a.cfg.ConfigPath)
	if err != nil {
		return fmt.Errorf("awg-quick strip: %w (%s)", err, strings.TrimSpace(string(stripped)))
	}

	tmp, err := os.CreateTemp("", "ice-awg-syncconf-*.conf")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(stripped); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	out, err := a.cfg.runCmd(ctx, a.cfg.AwgBin, "syncconf", iface, tmpPath)
	if err != nil {
		return fmt.Errorf("awg syncconf: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (a *Adapter) restartViaSystemctl(parent context.Context, iface string) error {
	if a.cfg.SystemctlBin == "" {
		return errors.New("syncconf failed and no SystemctlBin configured for fallback")
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	unit := a.unitName(iface)
	out, err := a.cfg.runCmd(ctx, a.cfg.SystemctlBin, "restart", unit)
	if err != nil {
		return fmt.Errorf("systemctl restart %s: %w (%s)", unit, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (a *Adapter) writeConfigSnapshot(inbound InboundConfig, peers []Peer) error {
	blob, err := renderConfig(inbound, peers)
	if err != nil {
		return fmt.Errorf("render %s config: %w", a.cfg.Protocol, err)
	}
	return writeConfig(a.cfg.ConfigPath, blob)
}

// sortedPeers returns peers in deterministic AllowedIP order so successive
// renders produce byte-identical configs.
func sortedPeers(in map[string]Peer) []Peer {
	out := make([]Peer, 0, len(in))
	for _, p := range in {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AllowedIP < out[j].AllowedIP })
	return out
}

// ensureCIDR appends /32 to a bare IP. Pass-through if already in CIDR form.
func ensureCIDR(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return ip + "/32"
}
