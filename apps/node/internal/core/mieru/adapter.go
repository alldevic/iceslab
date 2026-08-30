package mieru

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

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

	// Inbound is the static settings (listen port, MTU, logging).
	Inbound InboundConfig

	// RunCmd is the injectable command runner used by AddUser/RemoveUser/
	// ApplyInbound to invoke `mita apply config` and `mita reload`. Defaults
	// to os/exec; tests inject a fake.
	RunCmd RunCmdFunc
}

// RunCmdFunc executes an external command. Mirrors other adapters.
type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

type Adapter struct {
	coreVersion core.CachedVersion
	cfg         Config
	logger      *slog.Logger

	// mu protects in-memory state; held only for fast ops. The slow render +
	// `mita apply/reload` CLI runs under restartMu so Healthy()/GetStats don't
	// block behind a reload. Bug #10.
	mu      sync.Mutex
	users   map[string]User // userId → User
	started bool
	// N6 - sha256 of the last successfully-applied rendered config. A sync that
	// produces an identical blob skips the two `mita apply/reload` CLI forks.
	renderedHash [32]byte

	// restartMu serializes regenerateAndReload; never held with mu across IO.
	restartMu sync.Mutex

	// statusMu guards the cached answer to `mita status`. Its own lock, not
	// mu: the query forks, and holding the adapter's main lock across a
	// subprocess is what makes GetStats wait behind a healthcheck.
	statusMu      sync.Mutex
	statusAt      time.Time
	statusRunning bool
}

// How long a `mita status` answer is reused. Short enough that a proxy that
// stops is reported within one panel poll, long enough that a burst of
// healthchecks is one fork.
const statusCacheFor = 5 * time.Second

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	return &Adapter{
		cfg:    cfg,
		logger: logger,
		users:  make(map[string]User),
	}
}

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// invalidateStatus drops the cached `mita status` answer, so a call that just
// changed the proxy's state is not read back through a stale one.
func (a *Adapter) invalidateStatus() {
	a.statusMu.Lock()
	a.statusAt = time.Time{}
	a.statusMu.Unlock()
}

func (a *Adapter) Name() string { return Name }

// Engine reports the native proxy core (mita; no alternate engine).
func (a *Adapter) Engine() string { return "mieru" }

// Provisioned implements core.Provisionable: mita refuses to start a proxy with
// an empty user list, in its own words - `start mita server proxy failed: rpc
// error: ... no user found`. Users arrive from the panel after the agent is up,
// so a freshly installed mieru node has none.
//
// This is the same condition Start defers on, deliberately shared so the two
// cannot drift: an adapter whose Provisioned and Start disagree makes /healthz
// a guess (see core.Provisionable).
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.users) > 0
}

// Start writes the initial config and brings mita's proxy up. We invoke
// `mita apply config <path>` rather than spawning mita directly, mita's
// own systemd unit owns the lifecycle. The adapter rewrites the config,
// reloads it, and starts the proxy - the unit boots with that proxy IDLE.
//
// It must not fail on a node the panel has not populated yet: main.go treats a
// Start error as fatal and exits, systemd restarts the agent, and the agent is
// then never up long enough to be handed the users that would let mita start -
// a node that can only be repaired by the thing it is refusing to run. naive
// learned exactly this in cycle #8 (crash-loop on a missing Hostname) and
// deferred; mieru is the same shape and had never been asked the question,
// because until now it never ran the command that can refuse.
//
// In config-only mode (BinaryPath empty) Start writes the config and stops
// there, useful for tests and for dev hosts without mita installed.
func (a *Adapter) Start(ctx context.Context) error {
	if !a.Provisioned() {
		a.logger.Info("mieru adapter: no users yet, waiting for the panel's first addUser")
		return nil
	}
	return a.regenerateAndReload(ctx)
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
	started := a.started
	a.mu.Unlock()
	if !started {
		// Buffered. On a node whose Start deferred (no users yet), what ends
		// the deferral is the panel's inbound push: ApplyInbound calls
		// regenerateAndReload unconditionally, renders whatever users have
		// accumulated here, and starts the proxy. A mieru node with users and
		// no mieru inbound has nothing to serve, so idling is the right state.
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
	started := a.started
	a.mu.Unlock()
	if !started {
		return nil
	}
	return a.regenerateAndReload(context.Background())
}

// inboundCfgWire mirrors `MieruInboundCfg` in shared/transport.ts.
type inboundCfgWire struct {
	MTU int `json:"mtu"`
}

// ApplyInbound updates the inbound settings (MTU + port). MTU change is
// non-disruptive, existing sessions keep their negotiated MTU until
// reconnect. Port change DOES restart the listener (new socket bind).
//
// Wave-14 C1: port now flows from the panel binding to mieru's portBindings.
// Pre-wave port was install-time only and admin port changes from the UI
// were silently dropped. Fallback chain:
//
//	panel-pushed port → install-time ListenPort → 2012 (mieru default).
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	var wire inboundCfgWire
	if err := json.Unmarshal(rawCfg, &wire); err != nil {
		return fmt.Errorf("mieru ApplyInbound: parse cfg: %w", err)
	}

	a.mu.Lock()
	effectivePort := port
	if effectivePort == 0 {
		effectivePort = a.cfg.Inbound.ListenPort
	}
	if a.cfg.Inbound.MTU == wire.MTU && a.cfg.Inbound.ListenPort == effectivePort {
		a.mu.Unlock()
		a.logger.Info("mieru ApplyInbound: config unchanged, skipping")
		return nil
	}
	a.cfg.Inbound.MTU = wire.MTU
	if effectivePort != 0 {
		a.cfg.Inbound.ListenPort = effectivePort
	}
	newPort := a.cfg.Inbound.ListenPort
	a.mu.Unlock()
	a.logger.Info("mieru ApplyInbound: config changed",
		"mtu", wire.MTU, "port", newPort)
	return a.regenerateAndReload(context.Background())
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

// Healthy asks MITA whether its proxy service is serving, not whether this
// adapter's last config write succeeded.
//
// The difference is the whole point. mita's systemd unit and mita's PROXY are
// two states: the unit runs an RPC server that answers `apply config`, `reload`
// and `status`, and the proxy inside it starts only on `mita start`. Both
// `apply config` and `reload` answer rc=0 and "mita server is reloaded" while
// the proxy is IDLE and no socket exists (measured on a live node 2026-08-30),
// so a flag set from their success says "serving" about a core serving nobody.
// That is exactly what it said: the panel showed `running: true, drift: false`
// on a node where `ss` listed nothing on the inbound's port.
//
// Config-only mode keeps the old answer: there is no binary to ask.
func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	started, bin, run := a.started, a.cfg.BinaryPath, a.cfg.RunCmd
	a.mu.Unlock()
	if !a.Provisioned() {
		// Registered but not configured. Reporting this as healthy is what makes
		// every fresh node permanently `degraded`-or-green regardless of the
		// truth; core.Provisionable exists to keep the two apart.
		return false
	}
	if bin == "" || run == nil {
		return started
	}
	if !started {
		// Nothing has been rendered yet, so there is nothing to be healthy
		// about and no reason to fork.
		return false
	}
	return a.proxyRunning(context.Background())
}

// proxyRunning is `mita status`, cached for a beat.
//
// /healthz asks on every panel poll and the answer costs a fork, so it is held
// briefly - but only briefly, because the value of asking at all is that it
// changes when the proxy stops.
func (a *Adapter) proxyRunning(ctx context.Context) bool {
	a.statusMu.Lock()
	defer a.statusMu.Unlock()
	if time.Since(a.statusAt) < statusCacheFor {
		return a.statusRunning
	}
	a.mu.Lock()
	bin, run := a.cfg.BinaryPath, a.cfg.RunCmd
	a.mu.Unlock()
	out, err := run(ctx, bin, "status")
	if err != nil {
		a.logger.Warn("mita status failed; reporting the core as not serving",
			"err", err, "out", string(out))
		a.statusRunning = false
	} else {
		// `mita server status is "RUNNING"` / `... "IDLE"`. Matched on the
		// quoted word, which is the binary's own vocabulary.
		a.statusRunning = strings.Contains(string(out), `"RUNNING"`)
	}
	a.statusAt = time.Now()
	return a.statusRunning
}

// regenerateAndReload renders config + runs `mita apply/reload`. Bug #10:
// must NOT be called with a.mu held. restartMu serializes reloads; a.mu is
// taken only for the snapshot + the final started flag so Healthy()/GetStats
// don't block behind the multi-second CLI calls.
func (a *Adapter) regenerateAndReload(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	a.mu.Lock()
	users := sortedUsers(a.users)
	inbound := a.cfg.Inbound
	cfgPath := a.cfg.ConfigPath
	binPath := a.cfg.BinaryPath
	run := a.cfg.RunCmd
	a.mu.Unlock()

	blob, err := renderConfig(inbound, users)
	if err != nil {
		return fmt.Errorf("render mieru config: %w", err)
	}
	if cfgPath != "" {
		if err := writeConfig(cfgPath, blob); err != nil {
			return err
		}
	}
	if binPath == "" {
		a.mu.Lock()
		a.started = true
		a.mu.Unlock()
		a.logger.Info("mieru config written (config-only mode)", "users", len(users))
		return nil
	}

	// N6 - skip the two CLI forks when the rendered config is byte-identical to
	// the last one we applied. add/remove of an unrelated protocol's users, or a
	// no-op resync, otherwise paid `mita apply` + `mita reload` for nothing.
	hash := sha256.Sum256(blob)
	a.mu.Lock()
	unchanged := a.started && a.renderedHash == hash
	a.mu.Unlock()
	// "Same bytes as last time" is only a reason to skip if the core is also
	// still serving them. An agent restart, or a `mita stop` from anywhere,
	// leaves the config identical and the proxy idle - and skipping there is
	// how a resync that exists to repair the node repairs nothing.
	if unchanged && a.Provisioned() && !a.proxyRunning(ctx) {
		unchanged = false
		a.logger.Info("mieru config unchanged but mita is not serving; starting it")
	}
	if unchanged {
		a.logger.Debug("mieru config unchanged, skipping mita apply/reload", "users", len(users))
		return nil
	}

	// `mita apply config <path>` parses + applies the new config without
	// dropping existing sessions. Then `mita reload` (or just SIGHUP via
	// `mita`) finalises.
	if out, err := run(ctx, binPath, "apply", "config", cfgPath); err != nil {
		return fmt.Errorf("mita apply config: %w (%s)", err, string(out))
	}
	if out, err := run(ctx, binPath, "reload"); err != nil {
		// Reload might be a no-op for some mita versions where `apply
		// config` is sufficient; warn rather than fail.
		a.logger.Warn("mita reload returned non-zero (often safe after apply)",
			"err", err, "out", string(out))
	}
	// ...and then START it, which is the command that actually opens the port.
	//
	// Neither `apply config` nor `reload` does: mita boots its unit with the
	// proxy IDLE and both answer rc=0 against an idle proxy, so for as long as
	// this adapter existed it applied a perfect config to a core that listened
	// on nothing - `ss` empty, `mita status` IDLE - while the agent logged
	// "mieru (mita) reloaded" and the panel showed the core running. The
	// binary's own help says it plainly ("reload ... WITHOUT stopping proxy
	// service"); nobody asked it. `start` is idempotent: measured rc=0 and
	// "mita server proxy is running" against an already-running proxy.
	if !a.Provisioned() {
		// Config applied, proxy deliberately left idle: mita would refuse, and
		// a hard failure here is fatal to the whole agent (main.go). The first
		// AddUser comes back through this function and starts it.
		a.logger.Info("mieru: config applied, waiting for the panel's first user before starting mita")
	} else if out, err := run(ctx, binPath, "start"); err != nil {
		return fmt.Errorf("mita start: %w (%s)", err, string(out))
	}
	a.invalidateStatus()

	a.mu.Lock()
	a.started = true
	a.renderedHash = hash
	a.mu.Unlock()
	a.logger.Info("mieru (mita) reloaded", "users", len(users), "mtu", inbound.MTU)
	return nil
}

// CoreVersion implements core.Versioner: what the panel shows next to the
// version it pinned for this node, so drift between the two is visible instead
// of being something an operator has to ssh in to find out.
//
// mita answers a bare `<x.y.z>`, and refuses `--version` as an unknown command.
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
			a.logger.Warn("mita version query failed", "err", err)
			return ""
		}
		return core.ParseSemverish(out)
	})
}
