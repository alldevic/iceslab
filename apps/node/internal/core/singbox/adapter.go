// Package singbox implements CoreAdapter using the sing-box engine. The first
// protocol it serves is TUIC v5 (Name == "tuic"), which the xray-based cores
// can't do. Future sing-box protocols (AnyTLS, ShadowTLS) reuse this same
// subprocess runner.
//
// Architecture:
//   - sing-box runs as a managed subprocess (`sing-box run -c config.json`),
//     same lifecycle model as the xray adapter. ONE process per protocol, with
//     every inbound of that protocol on the node in it (A-055, multi.go).
//   - Users live inside each inbound's `users[]`, so AddUser/RemoveUser
//     re-render the config and restart sing-box (config-restart model), in
//     batches (batch.go): sing-box 1.13.14 has no live user management outside
//     shadowsocks, and its reload closes open connections too.
//   - regenerateAndRestart is serialized by restartMu; a.mu is held only for
//     fast in-memory snapshots, never across the subprocess Stop/Start IO, so
//     Healthy()/GetStats never block behind a multi-second restart (bug #1).
package singbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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
	// SSMListen is the loopback host:port of the ssm-api service, shadowsocks
	// only: users are handed to the running process instead of restarting it,
	// and counted there. Empty keeps the users in the config file.
	SSMListen string
	// QuietWindow and MaxWait batch user changes into one restart (batch.go).
	// Zero takes the defaults, 2 s and 10 s.
	QuietWindow time.Duration
	MaxWait     time.Duration
}

type Adapter struct {
	// See CoreVersion: asked again only when the binary on disk changes.
	versions core.VersionProbe

	cfg      Config
	protocol string
	logger   *slog.Logger

	// mu protects in-memory state (users, inbounds, proc, started, ctx). Held
	// ONLY for fast ops. The slow render + subprocess Stop/Start runs under
	// restartMu with mu released.
	mu      sync.Mutex
	started bool
	ctx     context.Context
	users   map[string]userEntry // key: userId
	// inbounds by the push's inbound id ("" for a push without one), all
	// rendered into the one process of this protocol (multi.go).
	inbounds map[string]InboundConfig
	// scopeDropped: ScopePush took inbounds out, RetainInbounds renders
	// without them (core.PushScoped).
	scopeDropped bool
	proc         *subprocess.Subprocess

	// restartMu serializes regenerateAndRestart so concurrent user/inbound
	// changes can't race the subprocess swap. Never held together with mu
	// across IO.
	restartMu sync.Mutex

	// The ssm-api hand-over of a managed shadowsocks (ssm_retry.go), under mu:
	// done for the current process, and the process generation a retry
	// belongs to (a newer start or a Stop ends an older retry). ssmErr is the
	// last failure of the hand-over, for CoreStatus.error.
	ssmSynced    bool
	ssmErr       string
	ssmGen       int
	ssmRetryBase time.Duration

	// The pending batch of user changes (batch.go), under mu. onFlush is a
	// test hook: the moment a batch decides to restart. clock is the wall
	// clock unless a test steps its own.
	batchTimer stopper
	batchFirst time.Time
	onFlush    func()
	clock      batchClock
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	if cfg.Protocol == "" {
		cfg.Protocol = Name
	}
	if cfg.QuietWindow == 0 {
		cfg.QuietWindow = defaultQuietWindow
	}
	if cfg.MaxWait == 0 {
		cfg.MaxWait = defaultMaxWait
	}
	return &Adapter{
		cfg:      cfg,
		protocol: cfg.Protocol,
		logger:   logger,
		users:    make(map[string]userEntry),
		inbounds: make(map[string]InboundConfig),
		clock:    wallClock{},
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
	hasInbound := len(a.inbounds) > 0
	a.mu.Unlock()
	if hasInbound {
		return a.regenerateAndRestart()
	}
	return nil
}

// Provisioned implements core.Provisionable: an inbound was pushed.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.inbounds) > 0
}

// Idle implements core.Idler: no inbound of this protocol on sing-box in the
// last push. Stops the process and forgets the applied inbounds (the ones
// ApplyInbound diffs against), so the same inbound pushed again brings it back.
// The adapter stays started: it is the process that goes, not the agent's
// readiness for the next push. The chain process is not this adapter's and is
// not touched.
func (a *Adapter) Idle(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	a.mu.Lock()
	a.dropBatchLocked()
	if len(a.inbounds) == 0 && a.proc == nil {
		a.mu.Unlock()
		return nil
	}
	a.inbounds = make(map[string]InboundConfig)
	proc := a.proc
	a.proc = nil
	a.mu.Unlock()
	a.logger.Info("singbox: no inbound in the last push, stopped", "protocol", a.protocol)
	if proc == nil {
		return nil
	}
	return proc.Stop(ctx)
}

func (a *Adapter) Stop(ctx context.Context) error {
	// Under restartMu, so a render already under way (a batch that fired the
	// moment Stop came) finishes first and its process is the one stopped
	// here; and every render after this sees started == false and starts
	// nothing (AUDT, 22.10: a batch brought sing-box back up after Stop).
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	a.mu.Lock()
	a.dropBatchLocked()
	a.started = false
	proc := a.proc
	a.proc = nil
	a.mu.Unlock()
	if proc == nil {
		return nil
	}
	return proc.Stop(ctx)
}

// AddUser registers a user on every inbound of this protocol. Idempotent:
// re-adding identical credentials is a no-op (no restart).
func (a *Adapter) AddUser(user core.User) error {
	return a.addUser(user, "")
}

// AddUserOn implements core.ScopedUserAdder (A-022): the user is on these
// inbounds of this protocol only.
func (a *Adapter) AddUserOn(user core.User, inboundIDs []string) error {
	ids := append([]string(nil), inboundIDs...)
	sort.Strings(ids)
	scope := strings.Join(ids, ",")
	if scope == "" {
		return a.RemoveUser(user.UserID)
	}
	return a.addUser(user, scope)
}

func (a *Adapter) addUser(user core.User, scope string) error {
	uuid, password := a.credsFor(user)
	if uuid == "" && password == "" {
		// No credentials for this protocol, nothing to do.
		return nil
	}
	desired := userEntry{UUID: uuid, Password: password, Username: user.Username, Inbounds: scope}
	a.mu.Lock()
	cur, existed := a.users[user.UserID]
	if existed && cur == desired {
		a.mu.Unlock()
		return nil
	}
	a.users[user.UserID] = desired
	held := sortedHeld(a.inbounds)
	a.mu.Unlock()
	// Nothing runs without an inbound; the first ApplyInbound renders them.
	if len(held) == 0 {
		return nil
	}
	// shadowsocks: straight into the running process, no restart.
	if a.ssmOn() {
		var prev *userEntry
		if existed {
			prev = &cur
		}
		if a.ssmChange(user.UserID, prev, &desired) {
			return nil
		}
	}
	a.scheduleRestart()
	return nil
}

// ssmChange hands one user change to the running process over ssm-api.
// False sends the caller to a restart.
//
// Under restartMu (П-5, 22.10): taken without it, a change landing while a
// restart was in its check went to the old process, and the hand-over after
// the start synced the users as they were before the change, so an added
// user was gone and a removed one back, until the next restart. Now a change
// waits out a restart and is then put to the process that runs; the sync
// after a start reads the users as they are by then (ssmSyncAll's callers).
func (a *Adapter) ssmChange(userID string, prev, next *userEntry) bool {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	// The inbounds as the process that runs now holds them, after any
	// restart this waited out.
	a.mu.Lock()
	held := sortedHeld(a.inbounds)
	running := a.proc != nil && a.proc.Running()
	a.mu.Unlock()
	if !running || len(held) == 0 {
		return false
	}
	if err := a.ssmApplyUser(context.Background(), userID, prev, next, held); err != nil {
		a.logger.Warn("singbox: ssm-api change failed, restarting with it instead", "user", userID, "err", err)
		return false
	}
	return true
}

// usersNow is a copy of the users as they are, under mu.
func (a *Adapter) usersNow() map[string]userEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]userEntry, len(a.users))
	for k, v := range a.users {
		out[k] = v
	}
	return out
}

// ssmOn: a managed shadowsocks adapter, its users handed over ssm-api.
func (a *Adapter) ssmOn() bool {
	return a.protocol == "shadowsocks" && a.cfg.SSMListen != ""
}

// ssm is the client for one managed inbound, by its id (ssmPath).
func (a *Adapter) ssm() *ssmClient {
	if !a.ssmOn() {
		return nil
	}
	return newSSMClient(a.cfg.SSMListen)
}

// ssmApplyUser moves one user to what next says, inbound by inbound: put
// where they serve, remove where they no longer do. prev/next nil = absent.
func (a *Adapter) ssmApplyUser(ctx context.Context, userID string, prev, next *userEntry, held []heldInbound) error {
	for _, h := range held {
		c := newSSMClient(a.cfg.SSMListen).at(ssmPath(h.id))
		switch {
		case next != nil && next.servesOn(h.id):
			if err := c.put(ctx, userID, core.DeriveSsPassword(next.Password, h.cfg.Method)); err != nil {
				return err
			}
		case prev != nil && prev.servesOn(h.id):
			if err := c.remove(ctx, userID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *Adapter) running() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.proc != nil && a.proc.Running()
}

// countsUsers: this binary was built with v2ray_api, the only per-user
// counters sing-box has besides ssm-api. The pinned 1.13.14 release is NOT
// (its Tags line has no with_v2ray_api), and a config carrying the block is
// refused at start: "create v2ray-server: v2ray api is not included in this
// build" (found 22.10, every user core of sing-box on the pinned binary
// failed to start). Read from `sing-box version`, cached until the file
// changes, so a binary rebuilt with the tag turns the counters on by itself.
func (a *Adapter) countsUsers() bool {
	out, ok := a.versions.Answer(a.cfg.BinaryPath, []string{"version"}, nil)
	return ok && hasBuildTag(out, "with_v2ray_api")
}

// hasBuildTag reads the "Tags:" line of `sing-box version`.
func hasBuildTag(versionOut, tag string) bool {
	for _, line := range strings.Split(versionOut, "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "Tags:")
		if !ok {
			continue
		}
		for _, t := range strings.Split(rest, ",") {
			if strings.TrimSpace(t) == tag {
				return true
			}
		}
	}
	return false
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
	cur, ok := a.users[userID]
	if !ok {
		a.mu.Unlock()
		return nil
	}
	delete(a.users, userID)
	held := sortedHeld(a.inbounds)
	a.mu.Unlock()
	if len(held) == 0 {
		return nil
	}
	if a.ssmOn() && a.ssmChange(userID, &cur, nil) {
		return nil
	}
	a.scheduleRestart()
	return nil
}

// GetStats reports per-user cumulative byte counters, read from sing-box's
// v2ray_api via the xray-binary stats client (see stats.go), or from ssm-api
// for a managed shadowsocks. Non-destructive read -> Cumulative=true, so the
// panel computes deltas against its snapshot (mirrors xray, #5). Zero counters
// when stats aren't configured or nothing runs; a query that fails is NoData,
// never zeros.
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	statsListen := a.cfg.StatsListen
	bin := a.cfg.XrayStatsBin
	run := a.cfg.RunCmd
	held := sortedHeld(a.inbounds)
	// Asked only of a process that is running. Every adapter is registered on
	// every node, so an idle one (no inbound pushed, no process) was asked
	// anyway and answered with a refused connection: six WARN lines every 30 s
	// per node, and the lines that mattered drowned in them (stand, 24.09).
	running := a.proc != nil && a.proc.Running()
	userIDs := make([]string, 0, len(a.users))
	for id := range a.users {
		userIDs = append(userIDs, id)
	}
	a.mu.Unlock()

	zero := func() *core.Stats {
		out := make([]core.UserStats, 0, len(userIDs))
		for _, id := range userIDs {
			out = append(out, core.UserStats{UserID: id})
		}
		return &core.Stats{Users: out}
	}

	if a.ssmOn() {
		if !running {
			return zero(), nil
		}
		// One ssm-api server per inbound; a user on two inbounds is one user,
		// and the panel bills the sum.
		sum := make(map[string]ssmUser)
		for _, h := range held {
			counters, err := a.ssm().at(ssmPath(h.id)).stats(context.Background())
			if err != nil {
				a.logger.Warn("singbox GetStats: ssm-api stats failed", "err", err)
				return &core.Stats{NoData: true, Cumulative: true}, nil
			}
			for name, c := range counters {
				s := sum[name]
				s.UplinkBytes += c.UplinkBytes
				s.DownlinkBytes += c.DownlinkBytes
				sum[name] = s
			}
		}
		out := make([]core.UserStats, 0, len(userIDs))
		for _, id := range userIDs {
			c := sum[id]
			out = append(out, core.UserStats{UserID: id, BytesIn: c.UplinkBytes, BytesOut: c.DownlinkBytes})
		}
		return &core.Stats{Users: out, Cumulative: true}, nil
	}

	// A binary without v2ray_api has no per-user counters to ask: presence
	// without bytes, as naive.
	if !a.countsUsers() {
		statsListen = ""
	}
	if statsListen == "" || bin == "" || run == nil || !running {
		return zero(), nil
	}

	counters, err := queryUserStats(context.Background(), run, bin, statsListen)
	if err != nil {
		// No data, not zeros (A-152/A-163): these counters are cumulative, and
		// a zero read as one dropped to 0 re-baselined every user's snapshot.
		a.logger.Warn("singbox GetStats: statsquery failed", "err", err)
		return &core.Stats{NoData: true, Cumulative: true}, nil
	}

	out := make([]core.UserStats, 0, len(userIDs))
	for _, id := range userIDs {
		c := counters[id]
		out = append(out, core.UserStats{UserID: id, BytesIn: c.UplinkBytes, BytesOut: c.DownlinkBytes})
	}
	return &core.Stats{Users: out, Cumulative: true}, nil
}

// Healthy: agent must be started; if an inbound is configured and a binary
// is set, the subprocess must be running. Before any inbound is applied (or in
// config-only mode) the agent itself is up, so report healthy.
func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.started {
		return false
	}
	if a.cfg.BinaryPath == "" || len(a.inbounds) == 0 {
		return true
	}
	// A managed shadowsocks whose users have not been handed over serves
	// nobody, whatever the process says (A-213).
	if a.ssmOn() && !a.ssmSynced {
		return false
	}
	return a.proc != nil && a.proc.Running()
}

// ApplyInbound is the push without an inbound id: one inbound, under "".
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	return a.ApplyIdentifiedInbound("", port, rawCfg)
}

// ApplyIdentifiedInbound implements core.IdentifiedApplier (A-055): one
// inbound of several, by the push's id, all in the one process of this
// protocol. Refused before it is stored when another inbound of the protocol
// already has its port. Idempotent.
func (a *Adapter) ApplyIdentifiedInbound(id string, port int, rawCfg json.RawMessage) error {
	newInbound, err := a.parseInbound(port, rawCfg)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if cur, ok := a.inbounds[id]; ok && cur == newInbound {
		a.mu.Unlock()
		a.logger.Info("singbox ApplyInbound: config unchanged, skipping")
		return nil
	}
	for other, in := range a.inbounds {
		if other != id && in.ListenPort == newInbound.ListenPort {
			a.mu.Unlock()
			return fmt.Errorf("singbox ApplyInbound: port %d is already taken by another %s inbound on sing-box", newInbound.ListenPort, a.protocol)
		}
	}
	prev, had := a.inbounds[id]
	a.inbounds[id] = newInbound
	a.mu.Unlock()
	err = a.regenerateAndRestart()
	var refused *refusedError
	if errors.As(err, &refused) {
		// The engine never took it (A-130 form): memory goes back to what
		// runs, so the next user change does not render it again.
		a.mu.Lock()
		if cur, ok := a.inbounds[id]; ok && cur == newInbound {
			if had {
				a.inbounds[id] = prev
			} else {
				delete(a.inbounds, id)
			}
		}
		a.mu.Unlock()
	}
	return err
}

// refusedError: the render or `sing-box check` said no, before anything on
// disk or in the process changed.
type refusedError struct{ err error }

func (e *refusedError) Error() string { return e.err.Error() }
func (e *refusedError) Unwrap() error { return e.err }

// checkConfig asks the engine about a candidate in a temp dir, never the live
// file. A refusal carries the engine's own words.
func checkConfig(ctx context.Context, bin string, blob []byte) error {
	dir, err := os.MkdirTemp("", "iceslab-singbox-check-")
	if err != nil {
		return fmt.Errorf("temp dir for the config check: %w", err)
	}
	defer os.RemoveAll(dir)
	candidate := filepath.Join(dir, "config.json")
	if err := os.WriteFile(candidate, blob, 0o600); err != nil {
		return fmt.Errorf("write candidate config: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "check", "-c", candidate).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sing-box rejected the config: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ScopePush implements core.PushScoped: the inbounds this push no longer
// carries leave before its own are applied, so a binding re-created on the
// same port is not refused against the one it replaces (A-199's shape).
func (a *Adapter) ScopePush(keep []string) {
	kept := make(map[string]bool, len(keep))
	for _, id := range keep {
		kept[id] = true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for id := range a.inbounds {
		if !kept[id] {
			delete(a.inbounds, id)
			a.scopeDropped = true
		}
	}
}

// RetainInbounds implements core.InboundReconciler: forget the inbounds the
// push no longer carries; with none left the process stops, as Idle.
func (a *Adapter) RetainInbounds(keep []string) error {
	kept := make(map[string]bool, len(keep))
	for _, id := range keep {
		kept[id] = true
	}
	a.mu.Lock()
	dropped := a.scopeDropped
	a.scopeDropped = false
	for id := range a.inbounds {
		if !kept[id] {
			delete(a.inbounds, id)
			dropped = true
		}
	}
	left := len(a.inbounds)
	running := a.proc != nil
	a.mu.Unlock()
	if !dropped {
		return nil
	}
	if left == 0 {
		if !running {
			return nil
		}
		return a.Idle(context.Background())
	}
	return a.regenerateAndRestart()
}

// parseInbound reads one pushed inbound for this adapter's protocol.
func (a *Adapter) parseInbound(port int, rawCfg json.RawMessage) (InboundConfig, error) {
	switch a.protocol {
	case "xray":
		var wire xrayFamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: parse xray cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		return ic, nil
	case "hysteria":
		var wire hy2FamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: parse hysteria cfg: %w", err)
		}
		return wire.toInboundConfig(port), nil
	case "shadowsocks":
		var wire ssFamilyWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: parse shadowsocks cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		return ic, nil
	case "shadowtls":
		var wire shadowtlsWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: parse shadowtls cfg: %w", err)
		}
		ic, err := wire.toInboundConfig(port)
		if err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: %w", err)
		}
		return ic, nil
	default:
		var wire inboundCfgWire
		if err := json.Unmarshal(rawCfg, &wire); err != nil {
			return InboundConfig{}, fmt.Errorf("singbox ApplyInbound: parse cfg: %w", err)
		}
		return wire.toInboundConfig(port), nil
	}
}

// render is the config of ONE inbound, as this adapter's protocol draws it.
// The v2ray_api block only when the binary carries it (countsUsers), and for
// shadowsocks the ssm-api service in its place when SSMListen is set.
func (a *Adapter) render(certPath, keyPath, statsListen string, inbound InboundConfig, users map[string]userEntry) ([]byte, error) {
	if !a.countsUsers() {
		statsListen = ""
	}
	switch a.protocol {
	case "anytls":
		return renderAnytlsConfig(certPath, keyPath, statsListen, inbound, users)
	case "xray":
		return renderXrayFamilyConfig(statsListen, inbound, users)
	case "hysteria":
		return renderHysteria2Config(certPath, keyPath, statsListen, inbound, users)
	case "shadowsocks":
		return renderShadowsocksConfig(statsListen, a.cfg.SSMListen, inbound, users)
	case "shadowtls":
		return renderShadowtlsConfig(statsListen, inbound, users)
	default:
		return renderConfig(certPath, keyPath, statsListen, inbound, users)
	}
}

// regenerateAndRestart re-renders the sing-box config from current state and
// swaps the subprocess. Serialized by restartMu; mu is only held for the
// snapshot. No-op in config-only mode (no binary) or before an inbound exists.
func (a *Adapter) regenerateAndRestart() error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	// This render carries every user change so far: a batch still waiting
	// would only restart again for nothing.
	a.dropBatchLocked()
	if !a.started {
		// Stopped (or not yet started): nothing is to run. Start renders
		// whatever is held when it comes.
		a.mu.Unlock()
		return nil
	}
	held := sortedHeld(a.inbounds)
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

	if binPath == "" || len(held) == 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	blob, err := a.renderAll(certPath, keyPath, statsListen, held, users)
	if err != nil {
		return &refusedError{fmt.Errorf("singbox: render config: %w", err)}
	}
	// Asked before anything is replaced, as the chain process and xray do.
	// A-110, 22.10: the config went straight over the running one with
	// os.WriteFile; a render the engine would not take put the process into
	// its restart budget on that file, with the working config gone. Now a
	// refusal leaves the running process and the file as they were, and the
	// write is atomic.
	if err := checkConfig(ctx, binPath, blob); err != nil {
		a.logger.Error("sing-box refused the new config, keeping the running one", "protocol", a.protocol, "err", err)
		return &refusedError{err}
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return fmt.Errorf("singbox: mkdir config dir: %w", err)
	}
	if err := atomicfile.Write(cfgPath, blob, 0o600); err != nil {
		return fmt.Errorf("singbox: write %s: %w", cfgPath, err)
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
	})
	if err := proc.Start(ctx); err != nil {
		return fmt.Errorf("singbox: start subprocess: %w", err)
	}

	a.mu.Lock()
	a.proc = proc
	a.mu.Unlock()
	// A managed shadowsocks inbound starts with nobody: its users are handed
	// over the API, every one of them, after each start, inbound by inbound.
	if a.ssmOn() {
		a.mu.Lock()
		a.ssmGen++
		gen := a.ssmGen
		a.ssmSynced = false
		a.ssmErr = ""
		a.mu.Unlock()
		// The users as they are NOW, not the copy the render started from
		// (П-5): a change made since went to the old process, and syncing the
		// copy would undo it on the new one.
		if err := a.ssmSyncAll(ctx, held, a.usersNow()); err != nil {
			a.mu.Lock()
			if a.ssmGen == gen {
				a.ssmErr = err.Error()
			}
			a.mu.Unlock()
			// A-213, 22.10: the managed inbound starts with nobody, and a
			// failed hand-over left it so: a 500 to a push, a journal line
			// after a batch. Now it is tried again until it takes, and the
			// core is not healthy until then.
			go a.retrySSMSync(ctx, gen, held)
			return fmt.Errorf("singbox: hand the users to ssm-api (retrying): %w", err)
		}
		a.mu.Lock()
		if a.ssmGen == gen {
			a.ssmSynced = true
			a.ssmErr = ""
		}
		a.mu.Unlock()
	}
	a.logger.Info("singbox: config applied and (re)started",
		"inbounds", len(held), "users", len(users))
	return nil
}

// ───── panel wire config ─────
//
// The panel pushes a small TUIC config blob via /applyInbounds. Port comes from
// the outer InboundDto.Port (first-class since slice 50); the rest is here.

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
	// The panel refuses the same three at save (security, realityMode, network:
	// singboxRefusesXrayField in apps/panel-backend/src/modules/profiles/
	// profiles.schemas.ts), so this is the second line, not the only one. A
	// change here is a change there.
	if w.Security != "" && w.Security != "reality" {
		return InboundConfig{}, fmt.Errorf("security %q not supported via sing-box engine (use the xray engine)", w.Security)
	}
	if w.RealityMode == "self-steal" {
		return InboundConfig{}, fmt.Errorf("reality self-steal mode not supported via sing-box engine (use the xray engine)")
	}
	if w.Network != "" && w.Network != "raw" {
		return InboundConfig{}, fmt.Errorf("transport %q not supported via sing-box engine (use the xray engine)", w.Network)
	}
	if len(w.Cascade) > 0 && string(w.Cascade) != "null" {
		return InboundConfig{}, fmt.Errorf("cascade not supported via sing-box engine (use the xray engine)")
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
}

func (w ssFamilyWire) toInboundConfig(port int) (InboundConfig, error) {
	if w.Method == "" {
		return InboundConfig{}, fmt.Errorf("shadowsocks method is required")
	}
	if w.ServerPSK == "" {
		return InboundConfig{}, fmt.Errorf("shadowsocks serverPsk is required")
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

// Installed reports whether the sing-box binary is on this machine.
func (a *Adapter) Installed() bool { return core.BinaryPresent(a.cfg.BinaryPath) }

// ReservedPorts: the loopback v2ray_api socket sing-box opens for per-user
// counters. Empty StatsListen means stats are off and nothing is held.
// The v2ray_api port only when the binary carries v2ray_api (otherwise it is
// not drawn and nothing listens there), and the ssm-api port of a managed
// shadowsocks.
func (a *Adapter) ReservedPorts() []core.ReservedPort {
	var out []core.ReservedPort
	if a.ssm() != nil {
		if p := core.PortOfListenAddr(a.cfg.SSMListen); p != 0 {
			out = append(out, core.ReservedPort{Owner: "singbox-ssm-api", Port: p})
		}
	} else if a.countsUsers() {
		if p := core.PortOfListenAddr(a.cfg.StatsListen); p != 0 {
			out = append(out, core.ReservedPort{Owner: "singbox-api", Port: p})
		}
	}
	return out
}

// CoreVersion implements core.Versioner from `sing-box version`, re-asked only when
// the binary on disk changes, so an upgrade shows without an agent restart.
// Empty when the binary is absent or does not answer.
func (a *Adapter) CoreVersion() string {
	return a.versions.Version(a.cfg.BinaryPath, []string{"version"}, nil)
}
