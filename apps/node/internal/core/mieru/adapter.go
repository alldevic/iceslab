package mieru

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"sort"
	"sync"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

const Name = "mieru"

// Config is per-instance settings for the MieruAdapter.
type Config struct {
	// BinaryPath to the `mita` executable. Empty → config-only mode.
	BinaryPath string

	// ConfigPath is where the generated YAML is written. mita reads it via
	// `mita apply config <path>`.
	ConfigPath string

	// Inbound is the install-time settings. Its MTU and logging level are
	// the process defaults; its port is used only by a push without an
	// inbound id (a panel older than multi-inbound).
	Inbound InboundConfig

	// RunCmd is the injectable command runner used by AddUser/RemoveUser/
	// ApplyInbound to invoke `mita apply config` and `mita reload`. Defaults
	// to os/exec; tests inject a fake.
	RunCmd RunCmdFunc
}

// RunCmdFunc executes an external command. Mirrors other adapters.
type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

type Adapter struct {
	// See CoreVersion: asked again only when the binary on disk changes.
	versions core.VersionProbe

	cfg    Config
	logger *slog.Logger

	// mu protects in-memory state; held only for fast ops. The slow render +
	// `mita apply/reload` CLI runs under restartMu so Healthy()/GetStats don't
	// block behind a reload. Bug #10.
	mu      sync.Mutex
	users   map[string]User // userId → User
	started bool
	// inbounds holds every pushed inbound by its panel id ("" for a push
	// without one). Empty means mita serves nothing: A-153, 22.10, mita
	// used to listen on the install-time 2012 from the agent's start, for
	// every user, with no mieru host in the panel, and kept listening after
	// the last one was removed.
	inbounds map[string]InboundConfig
	// serving: the last apply put mita's proxy up (`mita start`), and no Idle
	// has stopped it since.
	serving bool
	// N6 - sha256 of the last successfully-applied rendered config. A sync that
	// produces an identical blob skips the two `mita apply/reload` CLI forks.
	renderedHash [32]byte

	// restartMu serializes regenerateAndReload; never held with mu across IO.
	restartMu sync.Mutex
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	return &Adapter{
		cfg:      cfg,
		logger:   logger,
		users:    make(map[string]User),
		inbounds: make(map[string]InboundConfig),
	}
}

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (a *Adapter) Name() string { return Name }

// Engine reports the native proxy core (mita; no alternate engine).
func (a *Adapter) Engine() string { return "mieru" }

// Provisioned implements core.Provisionable: mita serves only what the panel
// pushed. The same condition regenerateAndReload renders from.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.inbounds) > 0
}

// Start marks the adapter ready and renders nothing (A-153): mita has nothing
// to serve until a push names an inbound. A restarted agent gets its inbounds
// back from the store's replay, which arrives through ApplyIdentifiedInbound
// like any push. mita's own systemd unit owns the daemon either way.
func (a *Adapter) Start(ctx context.Context) error {
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()
	return nil
}

func (a *Adapter) Stop(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.started = false
	if a.cfg.BinaryPath == "" {
		return nil
	}
	// Best-effort `mita stop`, if mita is run as a systemd unit, this is
	// a no-op. If it's running standalone, mita exits.
	if _, err := a.cfg.RunCmd(ctx, a.cfg.BinaryPath, "stop"); err != nil {
		a.logger.Warn("mita stop returned non-zero (often safe)", "err", err)
	}
	return nil
}

// Idle implements core.Idler: no mieru inbound in the last push. `mita stop`
// takes the proxy down and leaves the daemon (and its unix-socket RPC) up for
// the next `mita start` (mieru 3.37.0 pkg/appctl: Stop closes the proxy and
// sets IDLE, only Exit stops the RPC server). The inbounds are forgotten, so
// the same inbound pushed again brings mita back.
func (a *Adapter) Idle(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	a.mu.Lock()
	had := len(a.inbounds) > 0 || a.serving
	a.inbounds = make(map[string]InboundConfig)
	a.serving = false
	a.renderedHash = [32]byte{}
	bin, run := a.cfg.BinaryPath, a.cfg.RunCmd
	a.mu.Unlock()
	if !had || bin == "" {
		return nil
	}
	if out, err := run(ctx, bin, "stop"); err != nil {
		return fmt.Errorf("mieru idle: mita stop: %w (%s)", err, out)
	}
	a.logger.Info("mieru: no inbound in the last push, mita stopped")
	return nil
}

// RetainInbounds implements core.InboundReconciler: forget the inbounds the
// push no longer carries. With none left mita stops, as Idle.
var _ core.InboundReconciler = (*Adapter)(nil)

func (a *Adapter) RetainInbounds(keep []string) error {
	kept := make(map[string]bool, len(keep))
	for _, id := range keep {
		kept[id] = true
	}
	a.mu.Lock()
	dropped := 0
	for id := range a.inbounds {
		if !kept[id] {
			delete(a.inbounds, id)
			dropped++
		}
	}
	left := len(a.inbounds)
	a.mu.Unlock()
	if dropped == 0 {
		return nil
	}
	if left == 0 {
		return a.Idle(context.Background())
	}
	return a.regenerateAndReload(context.Background())
}

// AddUser registers a user in mita's user list. Idempotent.
//
// Reload is graceful, existing sessions survive; new connections use the
// updated user list.
func (a *Adapter) AddUser(user core.User) error {
	if user.XrayUUID == "" || user.Username == "" {
		return nil
	}
	a.mu.Lock()
	desired := User{Name: user.Username, Password: user.XrayUUID}
	if existing, ok := a.users[user.UserID]; ok && existing == desired {
		a.mu.Unlock()
		return nil
	}
	a.users[user.UserID] = desired
	serves := len(a.inbounds) > 0
	a.mu.Unlock()
	if !serves {
		return nil
	}
	return a.regenerateAndReload(context.Background())
}

func (a *Adapter) RemoveUser(userID string) error {
	a.mu.Lock()
	if _, ok := a.users[userID]; !ok {
		a.mu.Unlock()
		return nil
	}
	delete(a.users, userID)
	serves := len(a.inbounds) > 0
	a.mu.Unlock()
	if !serves {
		return nil
	}
	return a.regenerateAndReload(context.Background())
}

// inboundCfgWire mirrors `MieruInboundCfg` in shared/transport.ts.
type inboundCfgWire struct {
	MTU int `json:"mtu"`
}

// ApplyInbound is the push without an inbound id (a panel older than
// multi-inbound): one inbound, kept under "".
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	return a.ApplyIdentifiedInbound("", port, rawCfg)
}

// ApplyIdentifiedInbound implements core.IdentifiedApplier: one inbound of
// several, by the push's id. MTU change is non-disruptive, existing sessions
// keep their negotiated MTU until reconnect; a port change rebinds that
// inbound's listeners (mita reload updates the endpoints of a running mux).
//
// Refused before it is stored: two inbounds on one port, or two MTUs. mita
// keeps one MTU per process, so the second inbound with another one would
// silently run on the first's (A-055, 22.10).
//
// Port fallback for a push without one: install-time ListenPort, then 2012.
func (a *Adapter) ApplyIdentifiedInbound(id string, port int, rawCfg json.RawMessage) error {
	var wire inboundCfgWire
	if err := json.Unmarshal(rawCfg, &wire); err != nil {
		return fmt.Errorf("mieru ApplyInbound: parse cfg: %w", err)
	}

	a.mu.Lock()
	effectivePort := port
	if effectivePort == 0 {
		effectivePort = a.cfg.Inbound.ListenPort
	}
	next := InboundConfig{ListenPort: effectivePort, MTU: wire.MTU}
	if next.MTU == 0 {
		next.MTU = a.cfg.Inbound.MTU
	}
	prev, had := a.inbounds[id]
	if had && prev == next && a.serving {
		a.mu.Unlock()
		a.logger.Info("mieru ApplyInbound: config unchanged, skipping")
		return nil
	}
	if err := a.conflictLocked(id, next); err != nil {
		a.mu.Unlock()
		return fmt.Errorf("mieru ApplyInbound: %w", err)
	}
	a.inbounds[id] = next
	a.mu.Unlock()
	a.logger.Info("mieru ApplyInbound: config changed",
		"inboundId", id, "mtu", next.MTU, "port", next.ListenPort)

	err := a.regenerateAndReload(context.Background())
	var refused *refusedError
	if errors.As(err, &refused) {
		// mita never took it (A-130 form): memory goes back to what it runs.
		a.mu.Lock()
		if cur, ok := a.inbounds[id]; ok && cur == next {
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

// conflictLocked refuses `next` beside the other inbounds. a.mu held.
func (a *Adapter) conflictLocked(id string, next InboundConfig) error {
	n := next.withDefaults()
	for other, in := range a.inbounds {
		if other == id {
			continue
		}
		o := in.withDefaults()
		if o.ListenPort == n.ListenPort {
			return fmt.Errorf("port %d is already taken by another mieru inbound", n.ListenPort)
		}
		if o.MTU != n.MTU {
			return fmt.Errorf("MTU %d differs from %d of another mieru inbound on this node: mita keeps one MTU per process", n.MTU, o.MTU)
		}
	}
	return nil
}

// GetStats returns tracked users with zero counters. mita exposes
// `mita get-metrics --output json` for real numbers, wiring that
// is a follow-up (mirrors the SS adapter's soft-fail philosophy).
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	users := make([]core.UserStats, 0, len(a.users))
	for id := range a.users {
		users = append(users, core.UserStats{UserID: id})
	}
	return &core.Stats{Users: users}, nil
}

func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.started
}

// refusedError: render, write or `mita apply config` failed, so mita still
// holds the config it had.
type refusedError struct{ err error }

func (e *refusedError) Error() string { return e.err.Error() }
func (e *refusedError) Unwrap() error { return e.err }

// regenerateAndReload renders every inbound + runs `mita apply config`,
// `mita reload` and `mita start`. Bug #10: must NOT be called with a.mu held.
// restartMu serializes reloads; a.mu is taken only for the snapshot + the final
// flags so Healthy()/GetStats don't block behind the multi-second CLI calls.
// With no inbound there is nothing to render: Idle is what stops mita.
func (a *Adapter) regenerateAndReload(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	users := sortedUsers(a.users)
	inbounds := sortedInbounds(a.inbounds)
	base := a.cfg.Inbound
	cfgPath := a.cfg.ConfigPath
	binPath := a.cfg.BinaryPath
	run := a.cfg.RunCmd
	a.mu.Unlock()
	if len(inbounds) == 0 {
		return nil
	}

	blob, err := renderMulti(inbounds, base, users)
	if err != nil {
		return &refusedError{fmt.Errorf("render mieru config: %w", err)}
	}
	if cfgPath != "" {
		if err := writeConfig(cfgPath, blob); err != nil {
			return &refusedError{err}
		}
	}
	if binPath == "" {
		a.mu.Lock()
		a.serving = true
		a.mu.Unlock()
		a.logger.Info("mieru config written (config-only mode)", "users", len(users))
		return nil
	}

	// N6 - skip the CLI forks when the rendered config is byte-identical to
	// the last one we applied. add/remove of an unrelated protocol's users, or a
	// no-op resync, otherwise paid `mita apply` + `mita reload` for nothing.
	hash := sha256.Sum256(blob)
	a.mu.Lock()
	unchanged := a.serving && a.renderedHash == hash
	a.mu.Unlock()
	if unchanged {
		a.logger.Debug("mieru config unchanged, skipping mita apply/reload", "users", len(users))
		return nil
	}

	// `mita apply config <path>` REPLACES the stored config (3.37.0: the CLI
	// sends the file as is, and the server's SetConfig stores it whole; the
	// help text's "merges" is not what the code does), so a user or binding
	// missing from the file is gone. `mita reload` then hands a running proxy
	// the new users and endpoints without dropping sessions, and `mita start`
	// brings up a proxy that is not running (after Idle, or on a daemon that
	// started with no valid config); on a running one it only says so.
	if out, err := run(ctx, binPath, "apply", "config", cfgPath); err != nil {
		return &refusedError{fmt.Errorf("mita apply config: %w (%s)", err, string(out))}
	}
	if out, err := run(ctx, binPath, "reload"); err != nil {
		// Reload might be a no-op for some mita versions where `apply
		// config` is sufficient; warn rather than fail.
		a.logger.Warn("mita reload returned non-zero (often safe after apply)",
			"err", err, "out", string(out))
	}
	if out, err := run(ctx, binPath, "start"); err != nil {
		return fmt.Errorf("mita start: %w (%s)", err, string(out))
	}

	a.mu.Lock()
	a.serving = true
	a.renderedHash = hash
	a.mu.Unlock()
	a.logger.Info("mieru (mita) reloaded", "users", len(users), "inbounds", len(inbounds))
	return nil
}

// sortedInbounds is the map in port order, so a render from the same state is
// byte-identical.
func sortedInbounds(in map[string]InboundConfig) []InboundConfig {
	out := make([]InboundConfig, 0, len(in))
	for _, c := range in {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ListenPort < out[j].ListenPort })
	return out
}

// Installed reports whether the mita binary is on this machine.
func (a *Adapter) Installed() bool { return core.BinaryPresent(a.cfg.BinaryPath) }

// ReservedPorts: none, checked against mieru 3.37.0. mita's management RPC is
// a unix socket (/var/run/mita/mita.sock, pkg/appctl ServerUDS; the daemon
// listens with net.Listen("unix", ...) in pkg/cli/server.go) and mita opens no
// TCP listener of its own; its ports are the inbounds the panel already knows.
// And since A-153 it opens none of those before a push names one: the 2012
// it used to hold from the agent's start was the one port nobody had pushed.
//
// An EMPTY list and not a missing method: implementing the interface is how
// this adapter says "I hold nothing", which is an answer. Staying silent is
// what an adapter says when it cannot speak at all, and the panel refuses to
// call a port free on a node where anything is silent.
func (a *Adapter) ReservedPorts() []core.ReservedPort { return nil }

// CoreVersion implements core.Versioner from `mita version`, re-asked only when
// the binary on disk changes, so an upgrade shows without an agent restart.
// Empty when the binary is absent or does not answer.
func (a *Adapter) CoreVersion() string {
	return a.versions.Version(a.cfg.BinaryPath, []string{"version"}, nil)
}
