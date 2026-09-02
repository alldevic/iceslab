// Package singbox implements CoreAdapter using the sing-box engine. The first
// protocol it serves is TUIC v5 (Name == "tuic"), which the xray-based cores
// can't do. Future sing-box protocols (AnyTLS, ShadowTLS) reuse this same
// subprocess runner.
//
// Architecture:
//   - sing-box runs as a managed subprocess (`sing-box run -c config.json`),
//     same lifecycle model as the xray adapter.
//   - TUIC users live inside the inbound's `users[]`, so AddUser/RemoveUser
//     re-render the config and restart sing-box (config-restart model). Live
//     user management without restart is a later optimisation.
//   - regenerateAndRestart is serialized by restartMu; a.mu is held only for
//     fast in-memory snapshots, never across the subprocess Stop/Start IO, so
//     Healthy()/GetStats never block behind a multi-second restart (bug #1).
package singbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// Name matches dto.ProtocolName. The engine is sing-box; the protocol is TUIC.
const Name = "tuic"

// Config holds install-time settings. BinaryPath empty = config-only/inert
// mode (tests, or a node where sing-box isn't installed): the adapter accepts
// users/inbounds in memory but never spawns a subprocess.
type Config struct {
	// Protocol this adapter serves = its Name() for the dispatcher. "tuic"
	// (default) or "anytls". One sing-box engine, one adapter per protocol.
	Protocol   string
	BinaryPath string // path to the `sing-box` executable
	ConfigPath string // rendered config, passed to `sing-box run -c`
	CertPath   string // TLS certificate file (TUIC requires TLS)
	KeyPath    string // TLS private key file

	// StatsListen is the loopback host:port for sing-box's experimental
	// v2ray_api (e.g. "127.0.0.1:8082"). Empty disables stats collection.
	StatsListen string
	// XrayStatsBin is the xray binary used as a generic v2ray-stats gRPC
	// client to read StatsListen (sing-box ships no stats CLI). Empty means
	// GetStats degrades to zero counters.
	XrayStatsBin string
	// RunCmd runs the stats query; nil defaults to os/exec. Tests inject a fake.
	RunCmd RunCmdFunc
}

type Adapter struct {
	coreVersion core.CachedVersion
	// statsAPI caches the one question that decides whether this node can have
	// per-user accounting at all: was its sing-box built with with_v2ray_api.
	// See statsListenForConfig - a config carrying a block the binary lacks
	// does not degrade, it stops the core from starting.
	statsAPI core.CachedVersion
	cfg      Config
	protocol string
	logger   *slog.Logger

	// mu protects in-memory state (users, inbound, proc, started, ctx). Held
	// ONLY for fast ops. The slow render + subprocess Stop/Start runs under
	// restartMu with mu released.
	mu      sync.Mutex
	started bool
	ctx     context.Context
	users   map[string]userEntry // key: userId
	inbound InboundConfig
	proc    *subprocess.Subprocess

	// Restart tally, fed by the supervisor through OnRestart. The panel alerts
	// on growth: a restart that SUCCEEDS drops every live connection and leaves
	// the node online, so without a count nothing anywhere says it happened.
	restartsCrash     int
	restartsMemory    int
	lastRestartAt     time.Time
	lastRestartReason string
	// countingSince: when this adapter started tallying (agent start). Without
	// it "3 restarts" could mean this morning or six months ago.
	countingSince time.Time

	// restartMu serializes regenerateAndRestart so concurrent user/inbound
	// changes can't race the subprocess swap. Never held together with mu
	// across IO.
	restartMu sync.Mutex
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	if cfg.Protocol == "" {
		cfg.Protocol = Name
	}
	return &Adapter{
		cfg:           cfg,
		protocol:      cfg.Protocol,
		logger:        logger,
		users:         make(map[string]userEntry),
		countingSince: time.Now(),
	}
}

func (a *Adapter) Name() string { return a.protocol }

// Engine reports the proxy core: always "singbox" for this adapter, regardless
// of which protocol (tuic/anytls/...) it currently renders.
func (a *Adapter) Engine() string { return "singbox" }

// Start records the lifetime ctx (reused for subprocess spawns) and, if an
// inbound was already applied (e.g. persisted-store replay before Start),
// brings sing-box up. Normally the first ApplyInbound triggers the spawn.
func (a *Adapter) Start(ctx context.Context) error {
	a.mu.Lock()
	a.started = true
	a.ctx = ctx
	hasInbound := a.inbound.ListenPort != 0
	a.mu.Unlock()
	if hasInbound {
		return a.regenerateAndRestart()
	}
	return nil
}

func (a *Adapter) Stop(ctx context.Context) error {
	a.mu.Lock()
	a.started = false
	proc := a.proc
	a.proc = nil
	a.mu.Unlock()
	if proc == nil {
		return nil
	}
	return proc.Stop(ctx)
}

// AddUser registers a TUIC user and restarts sing-box so the new user lands in
// the inbound's users[]. Idempotent: re-adding identical credentials is a no-op
// (no restart).
func (a *Adapter) AddUser(user core.User) error {
	uuid, password := a.credsFor(user)
	if uuid == "" && password == "" {
		// No credentials for this protocol, nothing to do.
		return nil
	}
	a.mu.Lock()
	cur, ok := a.users[user.UserID]
	if ok && cur.UUID == uuid && cur.Password == password {
		a.mu.Unlock()
		return nil
	}
	a.users[user.UserID] = userEntry{
		UUID:     uuid,
		Password: password,
		Username: user.Username,
	}
	a.mu.Unlock()
	return a.regenerateAndRestart()
}

// credsFor extracts (uuid, password) for the adapter's protocol from a user.
// TUIC uses uuid+password; AnyTLS is password-only (uuid empty).
func (a *Adapter) credsFor(user core.User) (uuid, password string) {
	switch a.protocol {
	case "anytls":
		return "", user.AnytlsPassword
	case "xray":
		// vless/vmess use the xray uuid as uuid; trojan uses it as password.
		// Store it in both slots; renderXrayFamilyConfig picks the right one per
		// subprotocol. Empty xrayUuid -> the AddUser guard skips this user.
		return user.XrayUUID, user.XrayUUID
	case "hysteria":
		return "", user.HysteriaPassword
	case "shadowsocks":
		// Store the raw xray UUID; renderShadowsocksConfig derives the SS2022
		// uPSK from it (method-aware). Empty xrayUuid -> AddUser guard skips.
		return "", user.XrayUUID
	case "shadowtls":
		return "", user.ShadowtlsPassword
	default: // tuic
		return user.TuicUUID, user.TuicPassword
	}
}

// RemoveUser drops a user and restarts sing-box. Idempotent: removing an
// unknown user is a no-op (no restart).
func (a *Adapter) RemoveUser(userID string) error {
	a.mu.Lock()
	if _, ok := a.users[userID]; !ok {
		a.mu.Unlock()
		return nil
	}
	delete(a.users, userID)
	a.mu.Unlock()
	return a.regenerateAndRestart()
}

// GetStats reports per-user cumulative byte counters, read from sing-box's
// v2ray_api via the xray-binary stats client (see stats.go). Non-destructive
// read -> Cumulative=true, so the panel computes deltas against its snapshot
// (mirrors xray, #5). Degrades gracefully to zero counters when stats aren't
// configured or the query fails, so a stats outage never poisons the poller.
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	statsListen := a.cfg.StatsListen
	binPath := a.cfg.BinaryPath
	bin := a.cfg.XrayStatsBin
	run := a.cfg.RunCmd
	userIDs := make([]string, 0, len(a.users))
	for id := range a.users {
		userIDs = append(userIDs, id)
	}
	a.mu.Unlock()

	// Ask the same question the renderer asked: when this sing-box has no
	// v2ray_api, the config carries no endpoint and there is nothing to query.
	// Without this the poller dials a port nobody opened and logs a warning per
	// adapter per tick - six adapters, twice a minute, forever - which buries
	// the one message that actually says why (statsListenForConfig).
	statsListen = a.statsListenForConfig(binPath, statsListen)

	zero := func() *core.Stats {
		out := make([]core.UserStats, 0, len(userIDs))
		for _, id := range userIDs {
			out = append(out, core.UserStats{UserID: id})
		}
		return &core.Stats{Users: out}
	}

	if statsListen == "" || bin == "" || run == nil {
		return zero(), nil
	}

	// An adapter with no inbound has no counters to give, and asking it anyway is
	// not a degraded poll - it is the normal state of five of the six sing-box
	// adapters a --with-singbox node registers, only one of which usually has an
	// inbound.
	//
	// xray has the same guard for the same reason. Without it here, every such
	// node logged five "failed to dial" warnings per poll forever - and once a
	// failed query began reporting Degraded, those five became a permanent flag
	// that held ALL of the node's per-user billing. Caught by running the fix on
	// a live node and watching a user's counter stop moving; the flag is only
	// worth anything if it is off when nothing is wrong.
	if !a.Provisioned() {
		return zero(), nil
	}

	counters, err := queryUserStats(context.Background(), run, bin, statsListen)
	if err != nil {
		// No per-user rows, the way xray already does it, and `Degraded` so the
		// panel knows this poll is incomplete rather than zero.
		//
		// This used to return zero-counter rows - the exact thing xray's own
		// soft-fail comment forbids. It billed nothing only because `zero()`
		// leaves Cumulative false, which sends those rows down the per-poll-delta
		// path; an accident, not a guard, and one that stopped working the moment
		// the node ran a SECOND cumulative core: with xray also reporting, the
		// response is cumulative, the user's summed rows drop by sing-box's whole
		// counter, and the panel re-baselines and bills it again on recovery.
		// Measured live: +516 083 bytes on a user with no traffic at all.
		a.logger.Warn("singbox GetStats: statsquery failed", "err", err)
		return &core.Stats{Cumulative: true, Degraded: true}, nil
	}

	out := make([]core.UserStats, 0, len(userIDs))
	for _, id := range userIDs {
		c := counters[id]
		out = append(out, core.UserStats{UserID: id, BytesIn: c.UplinkBytes, BytesOut: c.DownlinkBytes})
	}
	return &core.Stats{Users: out, Cumulative: true}, nil
}

// Healthy: agent must be started; if a TUIC inbound is configured and a binary
// is set, the subprocess must be running. Before any inbound is applied (or in
// config-only mode) the agent itself is up, so report healthy.

// recordRestart accumulates what the supervisor did. Called from the subprocess
// watcher goroutine with no subprocess lock held, so taking a.mu here keeps the
// existing a.mu -> subprocess.mu ordering intact.
func (a *Adapter) recordRestart(ev subprocess.RestartEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if ev.Reason == subprocess.RestartReasonMemory {
		a.restartsMemory++
	} else {
		a.restartsCrash++
	}
	a.lastRestartAt = ev.At
	a.lastRestartReason = string(ev.Reason)
}

// RestartStats implements the optional core.RestartReporter so /healthz can
// carry the tally. MemoryLimitBytes stays 0: this adapter arms no memory
// watchdog, so Memory can only ever be 0 and saying "ceiling 0" is the honest
// report of a watchdog that is off.
func (a *Adapter) RestartStats() core.RestartStats {
	a.mu.Lock()
	st := core.RestartStats{
		Crash:      a.restartsCrash,
		Memory:     a.restartsMemory,
		LastAt:     a.lastRestartAt,
		LastReason: a.lastRestartReason,
		SinceAt:    a.countingSince,
	}
	proc := a.proc
	a.mu.Unlock()
	// Sampled outside a.mu: RSSBytes takes the subprocess lock and there is no
	// reason to hold both.
	if proc != nil {
		st.RSSBytes = proc.RSSBytes()
	}
	return st
}

// LastFailure returns what sing-box printed just before it stopped, or "" when
// this adapter owns no process to ask.
//
// It is what lets the panel say `not running: tuic (...bind: address already
// in use)` instead of `not running: tuic`. The second is true and useless:
// the reason is in the node's journal, on a machine the operator has to go
// find, and nothing ties it to the change they just saved. The panel has
// printed reasons since composeDownMessage landed; xray was the only core
// supplying one, so five of the six subprocess-owning adapters gave the
// operator a name and nothing else.
func (a *Adapter) LastFailure() string {
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil {
		return ""
	}
	return proc.LastLine()
}

// Provisioned reports whether the panel has pushed an inbound for this
// protocol yet.
//
// It is the SAME condition Start uses to decide whether to defer, which is what
// the interface requires — and the reason this adapter needed it. Sing-box is
// registered for every protocol the node might serve, so on a fresh node most
// of its adapters sit idle by design. Without this, /healthz reported them as
// `running: true` with no `provisioned` field, i.e. "configured and serving",
// which is neither: no config had been rendered and no process spawned. That
// is the exact distinction core.Provisionable was introduced to make, and this
// adapter — the newest family, TUIC/AnyTLS/ShadowTLS and every engine=singbox
// inbound — was the only one of the eight opted out of it.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.inbound.ListenPort != 0
}

func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.started {
		return false
	}
	// Deferred: Start was called, nothing was pushed, nothing runs. Saying yes
	// here is a green card over a protocol that serves nobody.
	if a.inbound.ListenPort == 0 {
		return false
	}
	if a.cfg.BinaryPath == "" {
		return true
	}
	return a.proc != nil && a.proc.Running()
}

// ApplyInbound parses the panel-pushed TUIC config, diffs against the last
// applied inbound, and on change re-renders + restarts. Idempotent.
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	var newInbound InboundConfig
	switch a.protocol {
	case "xray":
		var wire xrayFamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return fmt.Errorf("singbox ApplyInbound: parse xray cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		newInbound = ic
	case "hysteria":
		var wire hy2FamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return fmt.Errorf("singbox ApplyInbound: parse hysteria cfg: %w", err)
		}
		newInbound = wire.toInboundConfig(port)
	case "shadowsocks":
		var wire ssFamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return fmt.Errorf("singbox ApplyInbound: parse shadowsocks cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		newInbound = ic
	case "shadowtls":
		var wire shadowtlsWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return fmt.Errorf("singbox ApplyInbound: parse shadowtls cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		newInbound = ic
	default:
		var wire inboundCfgWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return fmt.Errorf("singbox ApplyInbound: parse cfg: %w", err)
		}
		newInbound = wire.toInboundConfig(port)
	}

	// Bridge A (2026-09-02). The bridge port is protocol-INDEPENDENT: the panel
	// sends it on whichever inbound it wants routed through the node's local
	// xray, and every protocol this adapter serves is bridged the same way. So
	// it is parsed once, here, rather than repeated in each of the five
	// per-protocol wire structs - which is the shape that let one renderer out
	// of six miss a rule that was supposed to hold for all of them.
	var bridge bridgeWire
	if err := json.Unmarshal(rawCfg, &bridge); err != nil {
		return fmt.Errorf("singbox ApplyInbound: parse bridge cfg: %w", err)
	}
	newInbound.BridgeSocksPort = bridge.BridgeSocksPort

	a.mu.Lock()
	if a.inbound == newInbound {
		a.mu.Unlock()
		a.logger.Info("singbox ApplyInbound: config unchanged, skipping")
		return nil
	}
	a.inbound = newInbound
	a.mu.Unlock()
	return a.regenerateAndRestart()
}

// regenerateAndRestart re-renders the sing-box config from current state and
// swaps the subprocess. Serialized by restartMu; mu is only held for the
// snapshot. No-op in config-only mode (no binary) or before an inbound exists.
func (a *Adapter) regenerateAndRestart() error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	inbound := a.inbound
	binPath := a.cfg.BinaryPath
	cfgPath := a.cfg.ConfigPath
	certPath := a.cfg.CertPath
	keyPath := a.cfg.KeyPath
	statsListen := a.cfg.StatsListen
	ctx := a.ctx
	oldProc := a.proc
	users := make(map[string]userEntry, len(a.users))
	for k, v := range a.users {
		users[k] = v
	}
	a.mu.Unlock()

	// Nothing pushed yet: there is no inbound to render. Distinct from the
	// binary being absent, which is checked AFTER the render below.
	if inbound.ListenPort == 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	// Ask the binary whether it can serve the stats API before rendering a
	// config that asks it to. See statsListenForConfig.
	statsListen = a.statsListenForConfig(binPath, statsListen)

	var blob []byte
	var err error
	switch a.protocol {
	case "anytls":
		blob, err = renderAnytlsConfig(certPath, keyPath, statsListen, inbound, users)
	case "xray":
		blob, err = renderXrayFamilyConfig(statsListen, inbound, users)
	case "hysteria":
		blob, err = renderHysteria2Config(certPath, keyPath, statsListen, inbound, users)
	case "shadowsocks":
		blob, err = renderShadowsocksConfig(statsListen, inbound, users)
	case "shadowtls":
		blob, err = renderShadowtlsConfig(statsListen, inbound, users)
	default:
		blob, err = renderConfig(certPath, keyPath, statsListen, inbound, users)
	}
	if err != nil {
		return fmt.Errorf("singbox: render config: %w", err)
	}
	// No path configured: accept the inbound in memory and write nothing, the
	// same contract xray's regenerateAndRestart states for an empty cfgPath.
	// Reachable only now that the render happens before the binary check —
	// before that, an adapter with no binary returned earlier than this.
	if cfgPath != "" {
		if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
			return fmt.Errorf("singbox: mkdir config dir: %w", err)
		}
		// Through atomicfile, like the other seven adapters. `os.WriteFile`
		// truncates the destination and then fills it, so sing-box reloading
		// during that window reads half a JSON document — and a write that dies
		// partway leaves that half under the final name with the working config
		// already gone, which is the state the agent cannot recover from on the
		// next boot. This adapter serves TUIC, AnyTLS, ShadowTLS and every
		// engine=singbox inbound, so it was the newest family that had opted
		// out of the oldest guarantee.
		if err := atomicfile.Write(cfgPath, blob, 0o600); err != nil {
			return fmt.Errorf("singbox: write %s: %w", cfgPath, err)
		}
	}

	// Config-only mode, the same one xray, naive, amneziawg, mtproto,
	// shadowsocks and mieru have: with no binary there is nothing to spawn, and
	// the rendered config is the whole observable result. This used to be
	// checked BEFORE the render, so sing-box was the one adapter of the eight
	// that produced nothing at all without a binary — which is why it could not
	// take part in the lifecycle contract the other seven are compared by.
	if binPath == "" {
		// Deliberately does NOT touch `started`: that word means "Start was
		// called and did not defer", and this function is also reached from
		// ApplyInbound. Setting it here would make an adapter that has only
		// ever been handed an inbound report itself healthy without ever
		// having been started.
		a.logger.Info("singbox config written (config-only mode)",
			"protocol", a.protocol, "path", cfgPath, "users", len(users))
		return nil
	}

	// Stop the old subprocess (IO under restartMu, mu released) then spawn anew.
	if oldProc != nil {
		_ = oldProc.Stop(context.Background())
	}
	proc := subprocess.New(subprocess.Config{
		Name:           a.protocol,
		Binary:         binPath,
		Args:           []string{"run", "-c", cfgPath},
		Logger:         a.logger,
		MaxRestarts:    subprocess.DefaultMaxRestarts,
		RestartBackoff: subprocess.DefaultRestartBackoff,
		// Without this the supervisor restarts the core and nobody counts it:
		// the node comes back online, every live connection was dropped, and
		// the panel has nothing to alert on.
		OnRestart: a.recordRestart,
	})
	if err := proc.Start(ctx); err != nil {
		return fmt.Errorf("singbox: start subprocess: %w", err)
	}

	a.mu.Lock()
	a.proc = proc
	a.mu.Unlock()
	a.logger.Info("singbox: config applied and (re)started",
		"port", inbound.ListenPort, "users", len(users))
	return nil
}

// ───── panel wire config ─────
//
// The panel pushes a small TUIC config blob via /applyInbounds. Port comes from
// the outer InboundDto.Port (first-class since slice 50); the rest is here.

// bridgeWire is the protocol-independent half of every sing-box inbound config:
// where this core hands its traffic instead of egressing itself. Decoded from
// the same blob as the per-protocol wire above, which ignores unknown keys, so
// an older panel that sends no bridge leaves it 0 and nothing changes.
type bridgeWire struct {
	BridgeSocksPort int `json:"bridgeSocksPort,omitempty"`
}

type inboundCfgWire struct {
	ServerName        string `json:"serverName,omitempty"`
	CongestionControl string `json:"congestionControl,omitempty"`
}

func (w inboundCfgWire) toInboundConfig(port int) InboundConfig {
	return InboundConfig{
		ListenPort:        port,
		ServerName:        w.ServerName,
		CongestionControl: w.CongestionControl,
	}
}

// xrayFamilyWire is the subset of the xray inbound config (xrayInboundCfgWire in
// the xray adapter / XrayInboundCfg in transport.ts) that the sing-box engine
// can render for vless/vmess/trojan. Field tags match what the panel pushes.
// Unsupported features are rejected in toInboundConfig so the operator gets a
// clear "use the xray engine" error rather than a silently-wrong config.
type xrayFamilyWire struct {
	Subprotocol        string          `json:"subprotocol"`
	Security           string          `json:"security"`
	Network            string          `json:"network"`
	RealityDest        string          `json:"realityDest"`
	RealityServerNames []string        `json:"realityServerNames"`
	RealityPrivateKey  string          `json:"realityPrivateKey"`
	RealityShortIDs    []string        `json:"realityShortIds"`
	RealityMaxTimeDiff int             `json:"realityMaxTimeDiff"`
	RealityMode        string          `json:"realityMode"`
	Flow               string          `json:"flow"`
	Cascade            json.RawMessage `json:"cascade"`
	// Fork fields the sing-box renderer has no equivalent for. Carried here
	// ONLY so toInboundConfig can reject them: left out of the struct they
	// would decode to nothing and the profile would apply looking healthy
	// while the feature it promises is absent.
	AbusePolicy        json.RawMessage `json:"abusePolicy"`
	RoutingFragments   json.RawMessage `json:"routingFragments"`
	RealityMldsa65Seed string          `json:"realityMldsa65Seed"`
	VlessDecryption    string          `json:"vlessDecryption"`
	Warp               json.RawMessage `json:"warp"`
	// REALITY knobs xray renders and sing-box has no equivalent for. Zero is
	// "off" for all three, so only a set value is worth refusing.
	RealityXver                             int `json:"realityXver"`
	RealityLimitFallbackUploadBytesPerSec   int `json:"realityLimitFallbackUploadBytesPerSec"`
	RealityLimitFallbackDownloadBytesPerSec int `json:"realityLimitFallbackDownloadBytesPerSec"`
}

// present reports whether a raw JSON field carries an actual object (a missing
// field and an explicit `null` both decode to a RawMessage we must treat as
// absent).
func present(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// toInboundConfig validates the pushed xray config against what the sing-box
// engine supports (EC2: vless/vmess/trojan, REALITY steal-others, network=raw)
// and maps it to an InboundConfig. Everything else errors out by design.
func (w xrayFamilyWire) toInboundConfig(port int) (InboundConfig, error) {
	sub := w.Subprotocol
	if sub == "" {
		sub = "vless"
	}
	if sub != "vless" && sub != "vmess" && sub != "trojan" {
		return InboundConfig{}, fmt.Errorf("subprotocol %q not supported via sing-box engine", sub)
	}
	// REALITY (steal-others) only. tls/none security needs operator-cert handling
	// (deferred); self-steal needs the local TLS fallback the xray adapter runs;
	// non-raw transports and cascade aren't mapped to sing-box yet.
	if w.Security != "" && w.Security != "reality" {
		return InboundConfig{}, fmt.Errorf("security %q not supported via sing-box engine (use the xray engine)", w.Security)
	}
	if w.RealityMode == "self-steal" {
		return InboundConfig{}, fmt.Errorf("reality self-steal mode not supported via sing-box engine (use the xray engine)")
	}
	if w.Network != "" && w.Network != "raw" {
		return InboundConfig{}, fmt.Errorf("transport %q not supported via sing-box engine (use the xray engine)", w.Network)
	}
	if present(w.Cascade) {
		return InboundConfig{}, fmt.Errorf("cascade not supported via sing-box engine (use the xray engine)")
	}
	// U4: the anti-abuse BLOCK rules live in the xray renderer, and the
	// sing-box engine emits no route rules at all, so a profile that carries an
	// abusePolicy here would render a node that enforces nothing while the
	// panel shows the policy as applied. Reject rather than no-op: the whole
	// point of the field is that an operator can tell what a node enforces.
	if present(w.AbusePolicy) {
		return InboundConfig{}, fmt.Errorf("abusePolicy not supported via sing-box engine (it renders no anti-abuse rules; use the xray engine)")
	}
	// B1: the egress policy compiles to xray routing rules and outbounds. The
	// sing-box renderer emits neither, so a node serving this profile would send
	// every flow out its default egress while the panel shows a split.
	if present(w.RoutingFragments) {
		return InboundConfig{}, fmt.Errorf("routingFragments not supported via sing-box engine (it renders no routing rules; use the xray engine)")
	}
	// U5: post-quantum REALITY (ML-DSA-65) and VLESS-Encryption are xray-core
	// features. Silently dropping them would leave a profile advertised as
	// post-quantum running classical X25519, which is the one downgrade that
	// must never be quiet.
	if w.RealityMldsa65Seed != "" {
		return InboundConfig{}, fmt.Errorf("post-quantum REALITY (realityMldsa65Seed) not supported via sing-box engine (use the xray engine)")
	}
	if w.VlessDecryption != "" {
		return InboundConfig{}, fmt.Errorf("VLESS-Encryption (vlessDecryption) not supported via sing-box engine (use the xray engine)")
	}
	// WARP egress, same shape as routingFragments above: the panel attaches it
	// per NODE, the xray renderer turns it into a wireguard outbound plus a
	// routing rule, and the sing-box renderer emits neither - its only outbound
	// is `direct`. Dropping it silently leaves a node whose panel says every
	// flow leaves through Cloudflare while every flow leaves its own IP, which
	// is a privacy promise the operator cannot see is broken. Measured on a lab
	// node 2026-08-30: warpEnabled true in the panel, `[{"type":"direct"}]` in
	// the rendered config.
	if present(w.Warp) {
		return InboundConfig{}, fmt.Errorf("WARP egress not supported via sing-box engine (it renders no outbound but direct; use the xray engine)")
	}
	// xray writes these into realitySettings (`xver`, `limitFallbackUpload/
	// Download`); sing-box's tls.reality block has no equivalent for either.
	// Zero means off, so only a set value is a promise that would go missing:
	// a fallback throttle that is not applied means a prober that fails REALITY
	// auth is forwarded at full speed, which is the opposite of what the knob
	// is for.
	if w.RealityXver != 0 {
		return InboundConfig{}, fmt.Errorf("realityXver not supported via sing-box engine (use the xray engine)")
	}
	if w.RealityLimitFallbackUploadBytesPerSec != 0 || w.RealityLimitFallbackDownloadBytesPerSec != 0 {
		return InboundConfig{}, fmt.Errorf("REALITY fallback rate limits not supported via sing-box engine (a prober that fails auth would be forwarded unthrottled; use the xray engine)")
	}
	if w.RealityPrivateKey == "" {
		return InboundConfig{}, fmt.Errorf("realityPrivateKey is required")
	}
	if len(w.RealityServerNames) == 0 {
		return InboundConfig{}, fmt.Errorf("realityServerNames must have at least one entry")
	}
	if len(w.RealityShortIDs) == 0 {
		return InboundConfig{}, fmt.Errorf("realityShortIds must have at least one entry")
	}

	flow := ""
	if sub == "vless" {
		flow = w.Flow // Vision is VLESS-only; vmess/trojan have no flow.
	}
	return InboundConfig{
		ListenPort:         port,
		Subprotocol:        sub,
		RealityDest:        w.RealityDest,
		RealityServerName:  w.RealityServerNames[0], // sing-box tls.server_name is single
		RealityPrivateKey:  w.RealityPrivateKey,
		RealityShortIDsCSV: strings.Join(w.RealityShortIDs, ","),
		RealityMaxTimeDiff: w.RealityMaxTimeDiff,
		Flow:               flow,
	}, nil
}

// hy2FamilyWire is the subset of the hysteria inbound config (inboundCfgWire in
// the hysteria adapter / HysteriaConfigSchema in transport.ts) the sing-box
// engine renders. All fields are optional; there are no unsupported-feature
// guards (unlike the xray family) because obfs/masquerade/bandwidth all map 1:1.
type hy2FamilyWire struct {
	ObfsPassword   string `json:"obfsPassword"`
	MasqueradeURL  string `json:"masqueradeUrl"`
	BrutalUpMbps   int    `json:"brutalUpMbps"`
	BrutalDownMbps int    `json:"brutalDownMbps"`
	// ServerName is an optional SNI for the self-signed cert; the hysteria wire
	// usually omits it (the xray-hysteria path is ACME-domain based).
	ServerName string `json:"serverName"`
}

func (w hy2FamilyWire) toInboundConfig(port int) InboundConfig {
	return InboundConfig{
		ListenPort:     port,
		ServerName:     w.ServerName,
		ObfsPassword:   w.ObfsPassword,
		MasqueradeURL:  w.MasqueradeURL,
		BrutalUpMbps:   w.BrutalUpMbps,
		BrutalDownMbps: w.BrutalDownMbps,
	}
}

// ssFamilyWire is the subset of the shadowsocks inbound config (inboundCfgWire
// in the shadowsocks adapter / ShadowsocksConfigSchema in transport.ts) the
// sing-box engine renders. method + serverPsk are required; per-user uPSKs are
// derived on the node from each user's xray UUID (see renderShadowsocksConfig).
type ssFamilyWire struct {
	Method    string `json:"method"`
	ServerPSK string `json:"serverPsk"`
	// U4: carried only to be rejected, see the abusePolicy guard on
	// xrayFamilyWire.toInboundConfig.
	AbusePolicy json.RawMessage `json:"abusePolicy"`
}

func (w ssFamilyWire) toInboundConfig(port int) (InboundConfig, error) {
	if w.Method == "" {
		return InboundConfig{}, fmt.Errorf("shadowsocks method is required")
	}
	if w.ServerPSK == "" {
		return InboundConfig{}, fmt.Errorf("shadowsocks serverPsk is required")
	}
	if present(w.AbusePolicy) {
		return InboundConfig{}, fmt.Errorf("abusePolicy not supported via sing-box engine (it renders no anti-abuse rules; use the xray engine)")
	}
	return InboundConfig{
		ListenPort: port,
		Method:     w.Method,
		ServerPSK:  w.ServerPSK,
	}, nil
}

// shadowtlsWire is the panel-pushed ShadowTLS config: the camouflage handshake
// target plus the inner shadowsocks key (a single server-wide key, reused via
// Method/ServerPSK). Per-user shadowtls passwords ride users[] from AddUser, not
// this wire. There is no share-link for ShadowTLS - clients consume it via full
// sing-box/clash config only.
type shadowtlsWire struct {
	Handshake  string `json:"handshake"`  // camouflage host[:port]
	SsMethod   string `json:"ssMethod"`   // inner ss cipher; default 2022-blake3-aes-128-gcm
	SsPassword string `json:"ssPassword"` // inner ss server key (panel-generated base64)
}

func (w shadowtlsWire) toInboundConfig(port int) (InboundConfig, error) {
	if w.Handshake == "" {
		return InboundConfig{}, fmt.Errorf("shadowtls handshake (camouflage domain) is required")
	}
	if w.SsPassword == "" {
		return InboundConfig{}, fmt.Errorf("shadowtls ssPassword (inner shadowsocks key) is required")
	}
	method := w.SsMethod
	if method == "" {
		method = "2022-blake3-aes-128-gcm"
	}
	return InboundConfig{
		ListenPort:         port,
		ShadowtlsHandshake: w.Handshake,
		Method:             method,
		ServerPSK:          w.SsPassword,
	}, nil
}

// CoreVersion implements core.Versioner: what the panel shows next to the
// version it pinned for this node, so drift between the two is visible instead
// of being something an operator has to ssh in to find out.
//
// sing-box answers `sing-box version <x.y.z>`.
// Empty in config-only mode (no binary) and when the query fails.
func (a *Adapter) CoreVersion() string {
	return a.coreVersion.Get(func() string {
		a.mu.Lock()
		bin, run := a.cfg.BinaryPath, a.cfg.RunCmd
		a.mu.Unlock()
		if bin == "" || run == nil {
			return ""
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := run(ctx, bin, "version")
		if err != nil {
			a.logger.Warn("sing-box version query failed", "err", err)
			return ""
		}
		return core.ParseSemverish(out)
	})
}
