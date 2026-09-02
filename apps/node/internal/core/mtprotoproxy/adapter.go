package mtprotoproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// Name is the protocol; Engine distinguishes this adapter from the mtg one.
// The dispatcher matches an inbound on BOTH, so the two can be registered side
// by side and an inbound picks with `engine: "mtprotoproxy"`.
const (
	Name   = "mtproto"
	Engine = "mtprotoproxy"
)

type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

type Config struct {
	// PythonPath is the interpreter. mtprotoproxy is a Python program, so the
	// "binary" of this core is python3 plus a script path.
	PythonPath string
	// ScriptPath is mtprotoproxy.py.
	ScriptPath string
	// ConfigPath is where we write the generated config.py. It is passed as
	// argv[1], which is the documented "launch with own config" form.
	ConfigPath string

	Inbound InboundConfig

	// AcceptLegacySecret keeps the mtg-era shared secret working during a
	// migration. OFF by default: it is a per-node migration state, not a
	// product setting, and leaving it on past the migration keeps a secret
	// alive that everybody has and nobody owns.
	AcceptLegacySecret bool

	RunCmd RunCmdFunc

	// MetricsURL is the scrape target. Defaults to the loopback port
	// renderConfig writes.
	MetricsURL    string
	metricsClient *http.Client
}

// Adapter implements core.CoreAdapter for MTProto over alexbers/mtprotoproxy.
//
// Unlike the mtg adapter, per-user state here is REAL: every user has their own
// secret, expiry, quota and connection cap, and the set is pushed into the
// running process with SIGUSR2 rather than a restart. That distinction is the
// whole point — a restart drops every connection the proxy is carrying, so
// adding one user would interrupt all of them.
type Adapter struct {
	coreVersion core.CachedVersion
	cfg         Config
	logger      *slog.Logger

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
	// legacySecret is the raw half of the mtg shared secret, when the node is
	// migrating and the panel pushed one. Empty otherwise.
	legacySecret string

	proc *subprocess.Subprocess

	restartsCrash     int
	restartsMemory    int
	lastRestartAt     time.Time
	lastRestartReason string
	countingSince     time.Time

	restartMu sync.Mutex
}

func New(cfg Config, logger *slog.Logger) *Adapter {
	if cfg.RunCmd == nil {
		cfg.RunCmd = defaultRunCmd
	}
	if cfg.MetricsURL == "" {
		port := cfg.Inbound.withDefaults().MetricsPort
		cfg.MetricsURL = fmt.Sprintf("http://127.0.0.1:%d/", port)
	}
	if cfg.metricsClient == nil {
		cfg.metricsClient = &http.Client{Timeout: 2 * time.Second}
	}
	return &Adapter{
		cfg:           cfg,
		logger:        logger,
		users:         make(map[string]User),
		countingSince: time.Now(),
	}
}

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (a *Adapter) Name() string   { return Name }
func (a *Adapter) Engine() string { return Engine }

// Provisioned reports whether the panel has told us enough to run. Only the
// masquerade domain is required: an inbound with no users yet must still listen
// and refuse everyone, or the first AddUser races the process coming up.
func (a *Adapter) Provisioned() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.Inbound.Domain != ""
}

func (a *Adapter) Start(ctx context.Context) error {
	if !a.Provisioned() {
		a.logger.Info("mtprotoproxy: domain not set, waiting for ApplyInbound from panel")
		return nil
	}
	return a.regenerateAndRestart(ctx)
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

// AddUser registers one subscriber and reloads the running process.
//
// This is where this engine differs from mtg, whose AddUser is a bookkeeping
// no-op because there is nothing per-user to add. Here the user's own secret
// goes into USERS and the proxy is told to re-read, so revocation and counting
// become possible at all.
//
// A user with no MtprotoSecret is REFUSED rather than given a generated one:
// the secret has to be the one the panel put in the link the buyer holds, and
// inventing one here produces a user who exists on the node and cannot connect
// — the failure that looks like a network problem and is not.
func (a *Adapter) AddUser(user core.User) error {
	// No secret means this push is not for us. The panel fans one credential
	// blob out to EVERY adapter — a wg device push carries only wg fields, and
	// each adapter takes what it recognises. Refusing here made the node log a
	// warning per device per sync, for a push that was never ours to answer.
	//
	// The guard this replaces was aimed at a real MTProto user arriving without
	// a secret. That cannot happen quietly: the panel derives it for every user
	// unconditionally, and the derivation is mirrored by a test on both sides.
	if user.MtprotoSecret == "" {
		// Two different silences used to share this line.
		//
		// A record carrying no credential of ours is not ours: the panel fans one
		// blob out to every adapter, and a wg DEVICE push carries only wg fields.
		// Refusing those made the node log a warning per device per sync.
		//
		// A PERSON record without a secret is the panel saying this person may not
		// use MTProto here - it is the only way it can say so, and it says it on
		// every sync. Ignoring it is what let a revoked entitlement live on: the
		// adapter would keep serving whoever it had been told about once, and
		// nothing else ever removes them. A person is told apart by carrying the
		// credential every person has and no device does.
		if user.XrayUUID == "" {
			return nil
		}
		return a.RemoveUser(user.UserID)
	}
	u := User{
		Name:   user.UserID,
		Secret: user.MtprotoSecret,
		// Backstops, not the enforcement. The panel removes an expired or
		// over-quota user; these bound the window where it cannot reach us.
		// MaxConns is deliberately left unset — see the note on the field.
		ExpiresAt:  user.MtprotoExpiresAt,
		QuotaBytes: user.MtprotoQuotaBytes,
	}
	if err := u.validate(); err != nil {
		return fmt.Errorf("mtprotoproxy AddUser: %w", err)
	}
	a.mu.Lock()
	prev, existed := a.users[u.Name]
	if existed && prev == u {
		a.mu.Unlock()
		return nil // idempotent, and no reload for a repeat push
	}
	a.users[u.Name] = u
	a.mu.Unlock()
	return a.regenerateAndReload()
}

func (a *Adapter) RemoveUser(userID string) error {
	a.mu.Lock()
	if _, ok := a.users[userID]; !ok {
		a.mu.Unlock()
		return nil // idempotent
	}
	delete(a.users, userID)
	a.mu.Unlock()
	return a.regenerateAndReload()
}

// inboundCfgWire mirrors MtprotoInboundCfg on the panel side.
type inboundCfgWire struct {
	Domain string `json:"domain"`
	// Secret is the INBOUND-level secret, which is what the mtg engine runs on
	// and what every buyer who ever added this proxy has saved in Telegram.
	//
	// This engine does not need it — here a secret belongs to a user — but it
	// is exactly what makes the switch seamless, so with AcceptLegacySecret it
	// is carried as one extra user (see legacyRawSecret). Without that flag it
	// is accepted and ignored, so a node can move to this engine before the
	// panel stops sending it.
	Secret string `json:"secret"`
}

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
	legacy := ""
	if a.cfg.AcceptLegacySecret {
		legacy = legacyRawSecret(wire.Secret, wire.Domain)
		if legacy == "" && wire.Secret != "" {
			// Say so rather than migrate silently without cover: an operator who
			// turned this on believes old links keep working.
			a.logger.Warn("mtprotoproxy: legacy secret not usable, old mtg links will NOT work",
				"reason", "not an ee+32hex+hex(domain) secret for this domain")
		}
	}
	unchanged := a.cfg.Inbound.Domain == wire.Domain &&
		a.cfg.Inbound.ListenPort == effectivePort &&
		a.legacySecret == legacy
	if unchanged {
		a.mu.Unlock()
		a.logger.Info("mtprotoproxy ApplyInbound: config unchanged, skipping")
		return nil
	}
	prevLegacy, prevDomain, prevPort := a.legacySecret, a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort
	a.legacySecret = legacy
	a.cfg.Inbound.Domain = wire.Domain
	if effectivePort != 0 {
		a.cfg.Inbound.ListenPort = effectivePort
	}
	newPort := a.cfg.Inbound.ListenPort
	a.mu.Unlock()

	// A domain or port change is a listener change, not a user-set change, so
	// it needs a restart — SIGUSR2 re-reads the config but does not rebind.
	a.logger.Info("mtprotoproxy ApplyInbound: restarting", "domain", wire.Domain, "port", newPort)
	if err := a.regenerateAndRestart(context.Background()); err != nil {
		// Put the remembered config BACK. Committing it before the work that
		// can fail turns one failure into a permanent one: the next identical
		// push compares equal, logs "config unchanged, skipping", and the
		// adapter never tries again. Measured in the field 2026-09-02 — a
		// missing ReadWritePaths entry made the first write fail, and every
		// retry after it was skipped rather than retried.
		a.mu.Lock()
		a.legacySecret, a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort = prevLegacy, prevDomain, prevPort
		a.mu.Unlock()
		return err
	}
	return nil
}

// GetStats reports per-user counters, which is the reason this engine exists.
//
// Counters are cumulative since the process started, so Cumulative is set and
// the panel diffs against its own snapshot. A SIGUSR2 reload does NOT reset
// them (it re-reads config, it does not restart); a crash-restart does, and the
// panel sees that as counters going backwards — which is what the restart tally
// is for.
//
// A failed scrape sets Degraded rather than reporting zeros: zeros are
// indistinguishable from "nobody used it", and the panel would bank them as a
// real reading.
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	names := make([]string, 0, len(a.users))
	for n := range a.users {
		names = append(names, n)
	}
	url := a.cfg.MetricsURL
	client := a.cfg.metricsClient
	a.mu.Unlock()
	sort.Strings(names)

	if len(names) == 0 {
		return &core.Stats{Cumulative: true}, nil
	}
	// LegacyUserName is deliberately absent from `names`: it is not a panel
	// user, and handing the panel a userId it has never heard of would put the
	// whole poll at risk for a row nobody can be billed for. Its traffic is
	// still visible where an operator running a migration actually looks — the
	// node's own metrics endpoint — and watching it fall to zero is the signal
	// that the legacy secret can be dropped.

	body, err := scrape(client, url)
	if err != nil {
		a.logger.Warn("mtprotoproxy: metrics scrape failed", "err", err)
		return &core.Stats{Cumulative: true, Degraded: true}, nil
	}
	traffic, err := parseUserMetrics(body)
	if err != nil {
		a.logger.Warn("mtprotoproxy: metrics parse failed", "err", err)
		return &core.Stats{Cumulative: true, Degraded: true}, nil
	}

	stats := &core.Stats{Cumulative: true, Users: make([]core.UserStats, 0, len(names))}

	// Node totals sum EVERY row in the scrape, not just the users we currently
	// serve. Three kinds of row end up here and all three are real traffic on
	// this node:
	//
	//   - the users below, who also get attributed;
	//   - the legacy cohort, which has no owner so nobody can be billed for it;
	//   - users already removed. mtprotoproxy keeps their entry in `user_stats`
	//     after they leave USERS (metrics iterate the stats, not the config), so
	//     their final counters keep being reported, frozen.
	//
	// That last one is why this sums the scrape rather than the current user
	// set. The panel reads this as a cumulative counter and deltas it, treating
	// any DROP as a core restart worth re-baselining. Summing only current users
	// would make every revocation look like a restart — the node's own history
	// would flatten each time somebody is cut off, which is exactly when it is
	// being looked at.
	for _, t := range traffic {
		stats.TotalBytesIn += t.BytesIn
		stats.TotalBytesOut += t.BytesOut
	}

	for _, n := range names {
		us := core.UserStats{UserID: n}
		// A user we know about with no row in the scrape has simply not used
		// the proxy since it started. Reporting zero is correct here, unlike
		// the failed-scrape case above: the endpoint answered and did not
		// mention them.
		if t := traffic[n]; t != nil {
			us.BytesIn, us.BytesOut = t.BytesIn, t.BytesOut
		}
		stats.Users = append(stats.Users, us)
	}
	return stats, nil
}

func scrape(client *http.Client, url string) (string, error) {
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}
	return string(body), nil
}

func (a *Adapter) Healthy() bool {
	a.mu.Lock()
	started := a.started
	proc := a.proc
	a.mu.Unlock()
	if !started {
		return false
	}
	if proc == nil {
		return true // config-only mode: nothing to be unhealthy
	}
	return proc.Running()
}

func (a *Adapter) recordRestart(ev subprocess.RestartEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if ev.Reason == subprocess.RestartReasonMemory {
		a.restartsMemory++
	} else {
		a.restartsCrash++
	}
	a.lastRestartAt = time.Now()
	a.lastRestartReason = string(ev.Reason)
}

func (a *Adapter) RestartStats() core.RestartStats {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := core.RestartStats{
		Crash:      a.restartsCrash,
		Memory:     a.restartsMemory,
		LastAt:     a.lastRestartAt,
		LastReason: a.lastRestartReason,
		SinceAt:    a.countingSince,
	}
	if a.proc != nil {
		st.RSSBytes = a.proc.RSSBytes()
	}
	return st
}

func (a *Adapter) LastFailure() string {
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil {
		return ""
	}
	return proc.LastLine()
}

// regenerateAndReload rewrites config.py and asks the RUNNING process to
// re-read it (SIGUSR2 -> init_config + ensure_users_in_user_stats). No restart,
// so existing connections survive — which is the whole reason to prefer this
// engine's reload over mtg's secret rotation.
//
// When nothing actually changed the signal is skipped. renderConfig sorts its
// users for exactly this: without a stable byte sequence every push would look
// like a change and reload the process for nothing.
func (a *Adapter) regenerateAndReload() error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	blob, changed, err := a.renderAndWrite()
	if err != nil {
		return err
	}
	_ = blob
	if !changed {
		return nil
	}

	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc == nil {
		return nil // config-only mode, or not started yet: it will be read on start
	}
	if err := proc.Signal(syscall.SIGUSR2); err != nil {
		return fmt.Errorf("mtprotoproxy: reload signal: %w", err)
	}
	a.logger.Info("mtprotoproxy: user set reloaded without restart")
	return nil
}

// renderAndWrite renders the current state and writes it if it differs from
// what is already on disk. Returns whether anything changed. Caller holds
// restartMu.
func (a *Adapter) renderAndWrite() ([]byte, bool, error) {
	a.mu.Lock()
	inbound := a.cfg.Inbound
	cfgPath := a.cfg.ConfigPath
	users := make([]User, 0, len(a.users)+1)
	for _, u := range a.users {
		users = append(users, u)
	}
	// The migration cover, if this node is carrying it. No expiry and no quota:
	// it is not somebody's plan, it is the door mtg left open, and it is closed
	// by turning the flag off — not by letting it lapse at an arbitrary date.
	if a.legacySecret != "" {
		users = append(users, User{Name: LegacyUserName, Secret: a.legacySecret})
	}
	prev := a.lastRendered
	a.mu.Unlock()

	blob, err := renderConfig(inbound, users)
	if err != nil {
		return nil, false, fmt.Errorf("render mtprotoproxy config: %w", err)
	}
	// The file is ALWAYS written, even when the bytes are identical, and always
	// through atomicfile: a config replaced in place can be read truncated by a
	// core reloading at that moment, and a write that dies partway leaves a
	// half-file under the final name. Skipping the write to save it would be
	// indistinguishable from that unsafe rewrite, which is what the write
	// contract in internal/core checks for — and it caught exactly this.
	//
	// What the comparison decides is the RELOAD, which is the expensive half:
	// signalling on every routine re-push would have the proxy re-reading its
	// config all day for nothing.
	if cfgPath != "" {
		if err := writeConfig(cfgPath, blob); err != nil {
			return nil, false, err
		}
	}
	changed := string(blob) != prev
	a.mu.Lock()
	a.lastRendered = string(blob)
	a.mu.Unlock()
	return blob, changed, nil
}

func (a *Adapter) regenerateAndRestart(ctx context.Context) error {
	a.restartMu.Lock()
	defer a.restartMu.Unlock()

	if _, _, err := a.renderAndWrite(); err != nil {
		return err
	}

	a.mu.Lock()
	python, script, cfgPath := a.cfg.PythonPath, a.cfg.ScriptPath, a.cfg.ConfigPath
	run := a.cfg.RunCmd
	a.mu.Unlock()

	if python == "" || script == "" {
		a.mu.Lock()
		a.started = true
		a.mu.Unlock()
		a.logger.Info("mtprotoproxy config written (config-only mode)")
		return nil
	}

	// The crypto guard. mtprotoproxy picks its AES backend at startup:
	// cryptography, then pycryptodome, then the BUNDLED pure-Python pyaes — and
	// on that last one it starts, serves, and prints a suggestion to the log.
	// Measured on the target node 2026-09-02: 0.4 MB/s against 3777 MB/s with
	// `cryptography`, four orders of magnitude. A proxy that carries media at
	// dial-up speed while reporting itself healthy is worse than one that
	// refuses to come up, so we refuse.
	if err := assertFastCrypto(ctx, run, python); err != nil {
		return err
	}

	a.mu.Lock()
	old := a.proc
	a.mu.Unlock()
	if old != nil {
		_ = old.Stop(ctx)
	}

	proc := subprocess.New(subprocess.Config{
		Name:           Name + "-" + Engine,
		Binary:         python,
		Args:           []string{script, cfgPath},
		Logger:         a.logger,
		MaxRestarts:    subprocess.DefaultMaxRestarts,
		RestartBackoff: subprocess.DefaultRestartBackoff,
		OnRestart:      a.recordRestart,
	})
	if err := proc.Start(ctx); err != nil {
		a.mu.Lock()
		a.proc = nil
		a.mu.Unlock()
		return fmt.Errorf("start mtprotoproxy: %w", err)
	}
	a.mu.Lock()
	a.proc = proc
	a.started = true
	a.mu.Unlock()
	a.logger.Info("mtprotoproxy (re)started", "domain", a.cfg.Inbound.Domain)
	return nil
}

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
			"mtprotoproxy refuses to start: no fast AES backend for %s (falls back to the bundled "+
				"pyaes, measured at 0.4 MB/s). Install python3-cryptography. Probe said: %s",
			python, string(out))
	}
	return nil
}

// CoreVersion reports the mtprotoproxy the node runs.
//
// It has no --version flag: upstream ships no version string at all, so there
// is nothing to parse and nothing to compare against a pin. Reporting the
// PYTHON version instead would be worse than reporting nothing, because the
// panel would show a number that looks like the proxy's and is not.
func (a *Adapter) CoreVersion() string {
	return a.coreVersion.Get(func() string { return "" })
}
