package mtprotoproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// Name is the protocol; the engine tells this adapter from the mtg one. The
// dispatcher matches an inbound on both, so the two can be registered side by
// side and a profile picks with `engine: "mtprotoproxy"`.
const Name = "mtproto"

type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

type Config struct {
	// PythonPath is the interpreter. mtprotoproxy is a Python program, so the
	// "binary" of this core is python3 plus a script path.
	PythonPath string
	// ScriptPath is mtprotoproxy.py. Empty → config-only mode.
	ScriptPath string
	// ConfigPath is where the generated config.py is written. It is passed as
	// argv[1], which is the documented "launch with own config" form.
	ConfigPath string

	Inbound InboundConfig

	// RunCmd is the injectable command runner for the crypto probe. Defaults to
	// os/exec; tests inject a fake.
	RunCmd RunCmdFunc
}

// Adapter implements core.CoreAdapter for MTProto over alexbers/mtprotoproxy.
//
// Unlike the mtg adapter, per-user state here is REAL: every user has their own
// secret, and the set is pushed into the running process with SIGUSR2 rather
// than a restart. That distinction is the whole point: a restart drops every
// connection the proxy is carrying, so adding one user would interrupt all of
// them.
type Adapter struct {
	cfg    Config
	logger *slog.Logger

	// mu guards in-memory state and is held only for fast work. The slow
	// render + subprocess work runs under restartMu so Healthy()/GetStats do
	// not queue behind it.
	mu      sync.Mutex
	users   map[string]User
	started bool
	// lastRendered is the config bytes currently on disk. Comparing against it
	// is what lets a no-op push skip the reload; renderConfig is deterministic
	// precisely so this comparison means something.
	lastRendered string

	proc *subprocess.Subprocess
	// lastStartFailed: the last start did not take (the crypto guard refused,
	// proc.Start failed, or the core died inside subprocess.StartupGrace). While
	// set, an identical push is not skipped as "unchanged": the core is down
	// under this very config. Cleared by a start that survives the window.
	// Under mu.
	lastStartFailed bool
	// refusal is why the last start was refused before anything was spawned
	// (the slow crypto backend), in words, for Fault(). Under mu.
	refusal string
	// restarts: the core's restart tally (RestartReporter), fed by OnRestart.
	restarts *core.RestartTally

	// restartMu serializes renders that touch the process; never held with mu
	// across IO.
	restartMu sync.Mutex
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	return &Adapter{
		restarts: core.NewRestartTally(),
		cfg:      cfg,
		logger:   logger,
		users:    make(map[string]User),
	}
}

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (a *Adapter) Name() string   { return Name }
func (a *Adapter) Engine() string { return "mtprotoproxy" }

// Provisioned implements core.Provisionable. Only the masquerade domain is
// required: an inbound with no users yet must still listen and refuse everyone,
// or the first AddUser races the process coming up. Shares the condition with
// Start so the two cannot drift apart.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.Inbound.Domain != ""
}

// configOnly: no interpreter or script to run, the adapter only writes config.py.
func (a *Adapter) configOnly() bool { return a.cfg.PythonPath == "" || a.cfg.ScriptPath == "" }

// Start writes the initial config and spawns mtprotoproxy, or defers to the
// first ApplyInbound when no domain is set.
func (a *Adapter) Start(ctx context.Context) error {
	if !a.Provisioned() {
		a.logger.Info("mtprotoproxy: domain not set, waiting for ApplyInbound from panel")
		return nil
	}
	// A core that forked and died inside the startup window, or one the crypto
	// guard refused, is not fatal at boot: the agent must stay up to report the
	// fault (/healthz says why), and the other cores must not go down with it.
	// Pushes still get the error. A core that could not be spawned at all stays
	// an error.
	err := a.regenerateAndRestart(ctx)
	if errors.Is(err, subprocess.ErrDiedInStartup) || errors.Is(err, errSlowCrypto) {
		a.logger.Warn("mtprotoproxy: core did not start at boot, agent stays up to report it", "err", err)
		return nil
	}
	return err
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

// Idle implements core.Idler: no mtprotoproxy inbound in the last push. Stops
// the proxy and forgets the domain (what Provisioned reads), so the same
// inbound pushed again brings it back.
func (a *Adapter) Idle(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	a.mu.Lock()
	if a.cfg.Inbound.Domain == "" && a.proc == nil {
		a.mu.Unlock()
		return nil
	}
	a.cfg.Inbound.Domain = ""
	a.lastRendered = ""
	a.lastStartFailed = false
	a.refusal = ""
	a.started = false
	proc := a.proc
	a.proc = nil
	a.mu.Unlock()
	a.logger.Info("mtprotoproxy: no inbound in the last push, stopped")
	if proc == nil {
		return nil
	}
	return proc.Stop(ctx)
}

// AddUser registers one subscriber and reloads the running process.
//
// This is where this engine differs from mtg, whose AddUser is a bookkeeping
// no-op because there is nothing per-user to add. Here the user's own secret
// goes into USERS and the proxy is told to re-read, so revocation becomes
// possible at all. Which users reach this inbound is the push's business
// (inboundIds, A-022): a user outside it gets RemoveUser.
//
// A user with no MtprotoSecret is not ours, and is not an error: the panel fans
// ONE credential blob out to every adapter, so a WireGuard device push or a
// user of another core carries none, and an error here would fail that user's
// result on a node running this engine beside the others (server.addUser). The
// panel derives a secret for every user, so an MTProto user does not arrive
// without one; nothing is invented here, because a secret that is not the one in
// the link the buyer holds makes a user who exists here and cannot connect.
func (a *Adapter) AddUser(user core.User) error {
	if user.MtprotoSecret == "" {
		a.logger.Debug("mtprotoproxy AddUser: no MtprotoSecret, not a user of this engine", "user", user.UserID)
		return nil
	}
	u := User{Name: user.UserID, Secret: user.MtprotoSecret}
	if err := u.validate(); err != nil {
		return fmt.Errorf("mtprotoproxy AddUser: %w", err)
	}
	a.mu.Lock()
	if prev, existed := a.users[u.Name]; existed && prev == u {
		a.mu.Unlock()
		return nil // idempotent, and no reload for a repeat push
	}
	a.users[u.Name] = u
	a.mu.Unlock()
	return a.regenerateAndReload(context.Background())
}

func (a *Adapter) RemoveUser(userID string) error {
	a.mu.Lock()
	if _, ok := a.users[userID]; !ok {
		a.mu.Unlock()
		return nil // idempotent
	}
	delete(a.users, userID)
	a.mu.Unlock()
	return a.regenerateAndReload(context.Background())
}

// inboundCfgWire mirrors MtprotoInboundCfg on the panel side.
type inboundCfgWire struct {
	Domain string `json:"domain"`
	// Secret is the INBOUND-level secret mtg runs on. This engine does not need
	// it, a secret belongs to a user here; it is accepted and ignored, so a node
	// can move to this engine before the panel stops sending it.
	Secret string `json:"secret"`
}

// ApplyInbound updates the masquerade domain and the port. Both are listener
// settings: SIGUSR2 re-reads the config but does not rebind, so a change of
// either restarts the process. The port is the inbound's; 0 keeps the one the
// agent started with.
func (a *Adapter) ApplyInbound(port int, rawCfg json.RawMessage) error {
	var wire inboundCfgWire
	if err := json.Unmarshal(rawCfg, &wire); err != nil {
		return fmt.Errorf("mtprotoproxy ApplyInbound: parse cfg: %w", err)
	}
	if wire.Domain == "" {
		return fmt.Errorf("mtprotoproxy ApplyInbound: domain is required")
	}

	a.mu.Lock()
	effectivePort := port
	if effectivePort == 0 {
		effectivePort = a.cfg.Inbound.ListenPort
	}
	if a.cfg.Inbound.Domain == wire.Domain &&
		a.cfg.Inbound.ListenPort == effectivePort && !a.lastStartFailed {
		a.mu.Unlock()
		a.logger.Info("mtprotoproxy ApplyInbound: config unchanged, skipping")
		return nil
	}
	prevDomain, prevPort := a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort
	a.cfg.Inbound.Domain = wire.Domain
	if effectivePort != 0 {
		a.cfg.Inbound.ListenPort = effectivePort
	}
	newPort := a.cfg.Inbound.ListenPort
	a.mu.Unlock()

	a.logger.Info("mtprotoproxy ApplyInbound: config changed, restarting",
		"domain", wire.Domain, "port", newPort)
	err := a.regenerateAndRestart(context.Background())
	if err != nil && !errors.Is(err, subprocess.ErrDiedInStartup) {
		// Put the remembered config BACK. Committing it before the work that
		// can fail turns one failure into a permanent one: the next identical
		// push compares equal, logs "config unchanged, skipping", and the
		// adapter never tries again. A core that did start and died in the
		// window keeps it: the config is what it was started with, and
		// lastStartFailed already makes the next identical push start it again.
		a.mu.Lock()
		a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort = prevDomain, prevPort
		a.mu.Unlock()
	}
	return err
}

// GetStats: until the metrics scrape lands (milestone 8.4) this answers as the
// mtg adapter does: the users it holds with zero counters and no totals, so a
// missing endpoint is not read by the panel as a core fault.
//
// A core that is not serving has nobody on it and says so: no users, rather than
// the cached roster with zero bytes, which reads as every user present on an
// inbound that does not exist (A-121).
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	serving := a.cfg.Inbound.Domain != "" && (a.configOnly() || (a.proc != nil && a.proc.Running()))
	if !serving {
		return &core.Stats{}, nil
	}
	users := make([]core.UserStats, 0, len(a.users))
	for name := range a.users {
		users = append(users, core.UserStats{UserID: name})
	}
	return &core.Stats{Users: users}, nil
}

func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	started, proc := a.started, a.proc
	a.mu.Unlock()
	if !started {
		return false
	}
	if a.configOnly() {
		return true
	}
	return proc != nil && proc.Running()
}

// regenerateAndReload rewrites config.py and asks the RUNNING process to
// re-read it (SIGUSR2 -> init_config + ensure_users_in_user_stats). No restart,
// so existing connections survive, which is the whole reason to prefer this
// engine's reload over mtg's secret rotation.
//
// When nothing actually changed the signal is skipped. renderConfig sorts its
// users for exactly this: without a stable byte sequence every push would look
// like a change and reload the process for nothing. When the signal cannot be
// delivered (the process is not running: it died between two pushes) the
// process is started again instead, so the user set is not lost.
func (a *Adapter) regenerateAndReload(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	// The panel adds its users to every adapter of the node, configured or not:
	// with no inbound there is nothing to render for, the users wait in memory.
	if !a.Provisioned() {
		return nil
	}
	changed, err := a.renderAndWrite()
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}

	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil {
		return nil // config-only mode, or not started yet: it is read on start
	}
	if err := proc.Signal(syscall.SIGUSR2); err != nil {
		a.logger.Warn("mtprotoproxy: reload signal not delivered, restarting", "err", err)
		return a.restartLocked(ctx)
	}
	a.logger.Info("mtprotoproxy: user set reloaded without restart")
	return nil
}

// renderAndWrite renders the current state and writes it. Returns whether it
// differs from what was written last. Caller holds restartMu.
func (a *Adapter) renderAndWrite() (bool, error) {
	a.mu.Lock()
	inbound := a.cfg.Inbound
	cfgPath := a.cfg.ConfigPath
	users := make([]User, 0, len(a.users))
	for _, u := range a.users {
		users = append(users, u)
	}
	prev := a.lastRendered
	a.mu.Unlock()

	blob, err := renderConfig(inbound, users)
	if err != nil {
		return false, fmt.Errorf("render mtprotoproxy config: %w", err)
	}
	// The file is ALWAYS written, even when the bytes are identical, and always
	// through atomicfile: a config replaced in place can be read truncated by a
	// core reloading at that moment, and a write that dies partway leaves a
	// half-file under the final name. Skipping the write to save it would be
	// indistinguishable from that unsafe rewrite, which is what the write
	// contract in internal/core checks for.
	//
	// What the comparison decides is the RELOAD, which is the expensive half:
	// signalling on every routine re-push would have the proxy re-reading its
	// config all day for nothing.
	if cfgPath != "" {
		if err := writeConfig(cfgPath, blob); err != nil {
			return false, err
		}
	}
	a.mu.Lock()
	a.lastRendered = string(blob)
	a.mu.Unlock()
	return string(blob) != prev, nil
}

func (a *Adapter) regenerateAndRestart(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()
	return a.restartLocked(ctx)
}

// restartLocked renders the config and (re)starts the proxy. Caller holds
// restartMu; a.mu is taken only for snapshots and the final proc swap, so
// Healthy()/GetStats don't block behind the multi-second Stop/Start.
func (a *Adapter) restartLocked(ctx context.Context) error {
	if !a.configOnly() {
		// The crypto guard comes before anything on disk or running changes: a
		// refused start leaves the previous config and process as they were.
		// mtprotoproxy picks its AES backend at startup (cryptography, then
		// pycryptodome, then the BUNDLED pure-Python pyaes) and on the last it
		// starts, serves and prints a suggestion to the log: 0.4 MB/s against
		// 3777 MB/s with `cryptography`, measured on the target node 2026-09-02.
		// A proxy that carries media at dial-up speed while reporting itself
		// healthy is worse than one that refuses to come up, so we refuse.
		if err := assertFastCrypto(ctx, a.cfg.RunCmd, a.cfg.PythonPath); err != nil {
			a.mu.Lock()
			a.lastStartFailed = true
			a.refusal = err.Error()
			a.mu.Unlock()
			a.logger.Error("mtprotoproxy: not started", "err", err)
			return err
		}
	}
	if _, err := a.renderAndWrite(); err != nil {
		return err
	}

	if a.configOnly() {
		a.mu.Lock()
		a.started = true
		a.refusal = ""
		a.mu.Unlock()
		a.logger.Info("mtprotoproxy config written (config-only mode)")
		return nil
	}

	a.mu.Lock()
	old := a.proc
	domain := a.cfg.Inbound.Domain
	a.mu.Unlock()
	if old != nil {
		_ = old.Stop(ctx)
	}
	proc := subprocess.New(subprocess.Config{
		Name:           "mtprotoproxy",
		Binary:         a.cfg.PythonPath,
		Args:           []string{a.cfg.ScriptPath, a.cfg.ConfigPath},
		Logger:         a.logger,
		MaxRestarts:    subprocess.DefaultMaxRestarts,
		RestartBackoff: subprocess.DefaultRestartBackoff,
		OnRestart:      a.restarts.Record,
	})
	if err := proc.Start(ctx); err != nil {
		a.mu.Lock()
		a.proc = nil
		a.lastStartFailed = true
		a.mu.Unlock()
		return fmt.Errorf("start mtprotoproxy: %w", err)
	}
	// Start only confirms the fork; a proxy that dies on its config or a taken
	// port exits moments later. On failure a.proc keeps pointing at the new
	// process: Fault() then says why it died and the supervisor keeps retrying
	// on its backoff (the grace is well under it).
	alive := proc.AliveAfter(ctx, subprocess.StartupGrace)
	a.mu.Lock()
	a.proc = proc
	a.started = true
	a.lastStartFailed = !alive
	a.refusal = ""
	a.mu.Unlock()
	if !alive {
		a.logger.Error("mtprotoproxy exited right after starting; what it printed is in the lines above",
			"grace", subprocess.StartupGrace, "domain", domain)
		return subprocess.DiedInStartup("mtprotoproxy", subprocess.StartupGrace)
	}
	a.logger.Info("mtprotoproxy (re)started", "domain", domain)
	return nil
}

// errSlowCrypto is what assertFastCrypto's error wraps, for the boot path.
var errSlowCrypto = errors.New("no fast AES backend")

// assertFastCrypto mirrors mtprotoproxy's own backend selection order
// (mtprotoproxy.py:391-396) and fails when it would land on the bundled pyaes.
func assertFastCrypto(ctx context.Context, run RunCmdFunc, python string) error {
	if run == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	const probe = `
import sys
try:
    import cryptography; print("cryptography"); sys.exit(0)
except ImportError:
    pass
try:
    import Crypto; print("pycryptodome"); sys.exit(0)
except ImportError:
    pass
print("pyaes")
sys.exit(1)
`
	out, err := run(ctx, python, "-c", probe)
	if err != nil {
		return fmt.Errorf(
			"mtprotoproxy refuses to start: %w for %s (falls back to the bundled "+
				"pyaes, measured at 0.4 MB/s). Install python3-cryptography. Probe said: %s",
			errSlowCrypto, python, string(out))
	}
	return nil
}

// Installed implements core.Installable: the script is on the machine.
func (a *Adapter) Installed() bool { return core.BinaryPresent(a.cfg.ScriptPath) }

// ReservedPorts: the metrics endpoint on loopback.
func (a *Adapter) ReservedPorts() []core.ReservedPort {
	a.mu.Lock()
	port := a.cfg.Inbound.withDefaults().MetricsPort
	a.mu.Unlock()
	return []core.ReservedPort{{Owner: "mtprotoproxy-metrics", Port: port}}
}

// RestartStats implements core.RestartReporter. MemoryLimitBytes stays 0: this
// adapter arms no memory watchdog, so Memory can only ever be 0.
func (a *Adapter) RestartStats() core.RestartStats {
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	// Sampled outside a.mu: RSSBytes takes the subprocess lock, and the tally
	// has its own, so neither is taken under a.mu.
	var rss uint64
	if proc != nil {
		rss = proc.RSSBytes()
	}
	return a.restarts.Stats(0, rss)
}
