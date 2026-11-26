package mtprotoproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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

	// ReadyAfter is how long a freshly started process is left alone before
	// SIGUSR2: python installs its handler a moment after the fork, and the
	// signal before that kills it (default action). 0 → defaultReadyAfter.
	ReadyAfter time.Duration
	// AcceptLegacySecret keeps the mtg-era shared secret working during a
	// migration. OFF by default: it is a per-node migration state, not a
	// product setting, and leaving it on past the migration keeps a secret
	// alive that everybody has and nobody owns.
	AcceptLegacySecret bool

	// MetricsURL is the scrape target. Empty → the loopback metrics port of the
	// inbound; tests point it at an httptest server.
	MetricsURL    string
	metricsClient *http.Client

	// Now is the clock the term of a user is judged by. nil → time.Now; tests
	// pin it to step across a term without waiting for it.
	Now func() time.Time

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
	// legacySecret is the raw half of the mtg shared secret, when the node is
	// migrating and the panel pushed one. Empty otherwise.
	legacySecret string

	// track holds, per user with a traffic limit, what the adapter knows of the
	// quota against the process counter (see quotaTrack). Under mu.
	track map[string]*quotaTrack
	// epoch counts process (re)starts: a counter read that began under an
	// earlier one describes a process that is gone and must not be applied.
	// Under mu.
	epoch uint64
	// expiryTimer wakes the adapter at the nearest term. Under mu.
	expiryTimer *time.Timer

	proc *subprocess.Subprocess
	// procStarted is when proc was spawned. Under mu.
	procStarted time.Time
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
	if cfg.metricsClient == nil {
		cfg.metricsClient = &http.Client{Timeout: 2 * time.Second}
	}
	return &Adapter{
		restarts: core.NewRestartTally(),
		cfg:      cfg,
		logger:   logger,
		users:    make(map[string]User),
		track:    make(map[string]*quotaTrack),
	}
}

func (a *Adapter) now() time.Time {
	if a.cfg.Now != nil {
		return a.cfg.Now()
	}
	return time.Now()
}

// quotaTrack is the adapter's memory of one user's quota against the engine's
// counter.
//
// The engine compares USER_DATA_QUOTA with a counter that starts at zero with
// each PROCESS and survives a SIGUSR2 reload. The panel pushes what is LEFT of
// the limit. The ceiling written to the file is last + remaining: the counter
// when the remainder was last known to be right, plus that remainder. While the
// process lives, usage moves last and remaining by the same amount, so the
// ceiling does not move and a re-render does not hand the allowance out again.
// A new process starts at zero, and what the old one used has been taken off
// remaining by then, so the ceiling restarts at the remainder, not at the limit.
type quotaTrack struct {
	remaining int64
	last      int64
	// needsBase: remaining just came from the panel and has not been paired
	// with a counter reading yet; the next reading becomes `last` without
	// being counted as usage.
	needsBase bool
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
	a.stopExpiryTimerLocked()
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
	a.stopExpiryTimerLocked()
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
	u := User{Name: user.UserID, Secret: user.MtprotoSecret, ExpiresAt: user.MtprotoExpiresAt}
	if user.MtprotoQuotaBytes != nil {
		u.Limited, u.QuotaBytes = true, *user.MtprotoQuotaBytes
	}
	if err := u.validate(); err != nil {
		return fmt.Errorf("mtprotoproxy AddUser: %w", err)
	}
	a.mu.Lock()
	if prev, existed := a.users[u.Name]; existed && prev.sameAs(u) {
		a.mu.Unlock()
		return nil // idempotent, and no reload for a repeat push
	}
	a.users[u.Name] = u
	if u.Limited {
		// The panel's word replaces what was tracked; `last` stays, it is the
		// counter and not a fact of the panel's.
		tr := a.track[u.Name]
		if tr == nil {
			tr = &quotaTrack{}
			a.track[u.Name] = tr
		}
		tr.remaining, tr.needsBase = u.QuotaBytes, true
	} else {
		delete(a.track, u.Name)
	}
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
	delete(a.track, userID)
	a.mu.Unlock()
	return a.regenerateAndReload(context.Background())
}

// inboundCfgWire mirrors MtprotoInboundCfg on the panel side.
type inboundCfgWire struct {
	Domain string `json:"domain"`
	// Secret is the INBOUND-level secret, which is what the mtg engine runs on
	// and what every buyer who ever added this proxy has saved in Telegram.
	//
	// This engine does not need it, a secret belongs to a user here, but it is
	// what makes the switch seamless: with AcceptLegacySecret it is carried as
	// one extra user (see legacyRawSecret). Without the flag it is accepted and
	// ignored, so a node can move to this engine before the panel stops
	// sending it.
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
	if a.cfg.Inbound.Domain == wire.Domain &&
		a.cfg.Inbound.ListenPort == effectivePort && a.legacySecret == legacy && !a.lastStartFailed {
		a.mu.Unlock()
		a.logger.Info("mtprotoproxy ApplyInbound: config unchanged, skipping")
		return nil
	}
	prevDomain, prevPort, prevLegacy := a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort, a.legacySecret
	a.legacySecret = legacy
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
		a.cfg.Inbound.Domain, a.cfg.Inbound.ListenPort, a.legacySecret = prevDomain, prevPort, prevLegacy
		a.mu.Unlock()
	}
	return err
}

// GetStats reports per-user counters, which is the reason this engine exists.
//
// Counters are cumulative since the process started, so Cumulative is set and
// the panel diffs against its own snapshot. A SIGUSR2 reload does NOT reset
// them (it re-reads config, it does not restart); a crash-restart does, and the
// panel sees that as counters going backwards, which is what the restart tally
// is for.
//
// A core that is not serving has nobody on it and says so: no users, rather than
// the cached roster with zero bytes, which reads as every user present on an
// inbound that does not exist (A-121).
//
// A failed scrape answers NoData rather than zeros: zeros read as a cumulative
// counter dropping to 0, and the next good poll would bill the whole counter at
// once.
func (a *Adapter) GetStats() (*core.Stats, error) {
	a.mu.Lock()
	serving := a.cfg.Inbound.Domain != "" && (a.configOnly() || (a.proc != nil && a.proc.Running()))
	names := make([]string, 0, len(a.users))
	for n := range a.users {
		names = append(names, n)
	}
	url := a.cfg.MetricsURL
	if url == "" {
		url = fmt.Sprintf("http://127.0.0.1:%d/", a.cfg.Inbound.withDefaults().MetricsPort)
	}
	client := a.cfg.metricsClient
	epoch := a.epoch
	a.mu.Unlock()
	if !serving {
		return &core.Stats{}, nil
	}
	sort.Strings(names)

	if len(names) == 0 {
		return &core.Stats{Cumulative: true}, nil
	}
	// LegacyUserName is deliberately absent from `names`: it is not a panel
	// user, and handing the panel a userId it has never heard of would put the
	// whole poll at risk for a row nobody can be billed for. Its traffic is
	// still visible where an operator running a migration actually looks, the
	// node's own metrics endpoint, and watching it fall to zero is the signal
	// that the legacy secret can be dropped.

	body, err := scrape(client, url)
	if err != nil {
		a.logger.Warn("mtprotoproxy: metrics scrape failed", "err", err)
		return &core.Stats{Cumulative: true, NoData: true}, nil
	}
	traffic, err := parseUserMetrics(body)
	if err != nil {
		a.logger.Warn("mtprotoproxy: metrics parse failed", "err", err)
		return &core.Stats{Cumulative: true, NoData: true}, nil
	}

	// The poll is a free reading of the counters the quota is tracked against.
	a.settle(counterTotals(traffic), epoch)

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
	// would make every revocation look like a restart.
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

// VersionFile is what bootstrap-mtprotoproxy.sh writes beside the script once
// the archive passed its sha256 and the patch applied: upstream ships no
// version string at all (no --version, no constant), and the python version
// would look like the proxy's and is not.
const VersionFile = ".iceslab-version"

// CoreVersion reports the version the bootstrap installed, "" when it did not
// say (a tree put there by hand), which the panel shows as unknown.
func (a *Adapter) CoreVersion() string {
	if a.cfg.ScriptPath == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(a.cfg.ScriptPath), VersionFile))
	if err != nil {
		return ""
	}
	return core.ParseVersion(b)
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
	// Whatever this render left out or kept, the next term is rearmed.
	defer a.scheduleExpiry()
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
	a.waitReady(ctx)
	if err := proc.Signal(syscall.SIGUSR2); err != nil {
		a.logger.Warn("mtprotoproxy: reload signal not delivered, restarting", "err", err)
		return a.restartLocked(ctx)
	}
	a.logger.Info("mtprotoproxy: user set reloaded without restart")
	return nil
}

// defaultReadyAfter bounds the wait for the handler of a fresh process; the
// wait ends earlier as soon as the listen port accepts (the handlers are
// installed before the servers start).
const defaultReadyAfter = 3 * time.Second

// waitReady holds a signal back until the process is past its startup: the
// listen port answers, or ReadyAfter has passed since the spawn. The config is
// already written, so a user added in the window is read by the signal that
// follows (a read at start could predate the write). Caller holds restartMu.
func (a *Adapter) waitReady(ctx context.Context) {
	a.mu.Lock()
	ready := a.cfg.ReadyAfter
	if ready == 0 {
		ready = defaultReadyAfter
	}
	deadline := a.procStarted.Add(ready)
	port := a.cfg.Inbound.ListenPort
	a.mu.Unlock()
	for time.Now().Before(deadline) {
		if port != 0 {
			if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 100*time.Millisecond); err == nil {
				_ = c.Close()
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// renderAndWrite renders the current state and writes it. Returns whether it
// differs from what was written last. Caller holds restartMu.
func (a *Adapter) renderAndWrite() (bool, error) {
	counters, epoch := a.pollCounters()
	a.settle(counters, epoch)
	return a.renderSettled()
}

// pollCounters reads the engine's per-user counters now: nil when there is
// nothing to read (no running process) or the read failed.
func (a *Adapter) pollCounters() (map[string]int64, uint64) {
	a.mu.Lock()
	epoch := a.epoch
	running := a.cfg.Inbound.Domain != "" && ((a.proc != nil && a.proc.Running()) ||
		(a.configOnly() && a.cfg.MetricsURL != ""))
	url := a.cfg.MetricsURL
	if url == "" {
		url = fmt.Sprintf("http://127.0.0.1:%d/", a.cfg.Inbound.withDefaults().MetricsPort)
	}
	client := a.cfg.metricsClient
	a.mu.Unlock()
	if !running {
		return nil, epoch
	}
	body, err := scrape(client, url)
	if err != nil {
		a.logger.Debug("mtprotoproxy: counters not read for the quota", "err", err)
		return nil, epoch
	}
	traffic, err := parseUserMetrics(body)
	if err != nil {
		return nil, epoch
	}
	return counterTotals(traffic), epoch
}

// counterTotals is what the engine compares a quota with: both directions.
func counterTotals(traffic map[string]*userTraffic) map[string]int64 {
	out := make(map[string]int64, len(traffic))
	for n, t := range traffic {
		out[n] = t.BytesIn + t.BytesOut
	}
	return out
}

// settle folds a counter reading into the quota tracking. nil counters (no
// reading) change nothing: the ceiling is then rendered from the last counter
// seen, which can only be at or under the real one, so the user is cut later
// than the allowance, never sooner. A user absent from a successful reading has
// used nothing since the process started. A reading taken under an earlier
// process (epoch) is dropped.
func (a *Adapter) settle(counters map[string]int64, epoch uint64) {
	if counters == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if epoch != a.epoch {
		return
	}
	for name, tr := range a.track {
		c := counters[name]
		switch {
		case tr.needsBase:
			tr.last, tr.needsBase = c, false
		case c >= tr.last:
			tr.remaining -= c - tr.last
			tr.last = c
		default:
			// The counter fell: the engine restarted behind our back, and
			// everything it counted since is new usage.
			tr.remaining -= c
			tr.last = c
		}
		if tr.remaining < 0 {
			tr.remaining = 0
		}
	}
}

// newProcessLocked: the counters of the old process are no longer the engine's.
// The caller has settled them first.
func (a *Adapter) newProcessLocked() {
	a.epoch++
	for _, tr := range a.track {
		tr.last = 0
	}
}

// renderSettled renders from the current state and writes it. Users past their
// term are left out: the engine is told at the instant, by the next reload, and
// not at the day boundary of USER_EXPIRATIONS.
func (a *Adapter) renderSettled() (bool, error) {
	a.mu.Lock()
	inbound := a.cfg.Inbound
	cfgPath := a.cfg.ConfigPath
	users := make([]User, 0, len(a.users)+1)
	now := a.now()
	for _, u := range a.users {
		if !u.ExpiresAt.IsZero() && !now.Before(u.ExpiresAt) {
			continue
		}
		if tr := a.track[u.Name]; u.Limited && tr != nil {
			u.QuotaBytes = tr.last + tr.remaining
			if u.QuotaBytes < 0 { // overflowed: far beyond any real limit
				u.QuotaBytes = math.MaxInt64
			}
		}
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
	if a.configOnly() {
		// The engine is not ours to restart here: its counters go on.
		if _, err := a.renderAndWrite(); err != nil {
			return err
		}
		a.mu.Lock()
		a.started = true
		a.refusal = ""
		a.mu.Unlock()
		a.scheduleExpiry()
		a.logger.Info("mtprotoproxy config written (config-only mode)")
		return nil
	}
	// The process about to be replaced is read one last time, so what it served
	// comes off the remainders; the new one counts from zero, and the ceiling is
	// rendered from the remainder alone, not from the limit.
	counters, epoch := a.pollCounters()
	a.settle(counters, epoch)
	a.mu.Lock()
	a.newProcessLocked()
	a.mu.Unlock()
	if _, err := a.renderSettled(); err != nil {
		return err
	}

	a.mu.Lock()
	old := a.proc
	domain := a.cfg.Inbound.Domain
	a.mu.Unlock()
	if old != nil {
		_ = old.Stop(ctx)
	}
	started := time.Now()
	proc := subprocess.New(subprocess.Config{
		StderrLevel:    stderrLevel,
		Name:           "mtprotoproxy",
		Binary:         a.cfg.PythonPath,
		Args:           []string{a.cfg.ScriptPath, a.cfg.ConfigPath},
		Logger:         a.logger,
		MaxRestarts:    subprocess.DefaultMaxRestarts,
		RestartBackoff: subprocess.DefaultRestartBackoff,
		OnRestart:      a.onProcessRestart,
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
	a.procStarted = started
	a.started = true
	a.lastStartFailed = !alive
	a.refusal = ""
	a.mu.Unlock()
	if !alive {
		a.logger.Error("mtprotoproxy exited right after starting; what it printed is in the lines above",
			"grace", subprocess.StartupGrace, "domain", domain)
		return subprocess.DiedInStartup("mtprotoproxy", subprocess.StartupGrace)
	}
	a.scheduleExpiry()
	a.logger.Info("mtprotoproxy (re)started", "domain", domain)
	return nil
}

// onProcessRestart: the supervisor is about to respawn a process that died (a
// crash, the memory watchdog). The new one reads the config on disk and counts
// from zero, so the file must not keep the ceiling of the old counter, or the
// user would be handed the allowance again (counter + remainder over a counter
// that starts at 0). The old counters can no longer be read: the remainders are
// as of the last poll, and what the process carried since is lost to the
// accounting, the usual slack of a backstop. Done off the watcher's goroutine
// (restartMu may be held by a caller that waits on it), well inside the
// supervisor's backoff.
func (a *Adapter) onProcessRestart(ev subprocess.RestartEvent) {
	a.restarts.Record(ev)
	go func() {
		a.restartMu.Lock()
		defer a.restartMu.Unlock()
		a.mu.Lock()
		a.newProcessLocked()
		a.mu.Unlock()
		if _, err := a.renderSettled(); err != nil {
			a.logger.Error("mtprotoproxy: config not rewritten for the restarted process", "err", err)
		}
	}()
}

// stopExpiryTimerLocked disarms the term timer. Caller holds mu.
func (a *Adapter) stopExpiryTimerLocked() {
	if a.expiryTimer != nil {
		a.expiryTimer.Stop()
		a.expiryTimer = nil
	}
}

// maxExpirySleep bounds one sleep so a stepped wall clock is noticed within the
// hour; the timer is rearmed after every wake.
const maxExpirySleep = time.Hour

// scheduleExpiry arms a wake-up at the nearest term still ahead. The exact
// cut-off of a user is the adapter's: at the term the user is left out of
// USERS and the engine is told, with no word from the panel (which is what the
// term is a backstop for). Armed only while the adapter is started, and
// disarmed by Stop and Idle, so a stopped process is never woken.
func (a *Adapter) scheduleExpiry() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopExpiryTimerLocked()
	if !a.started {
		return
	}
	now := a.now()
	var next time.Time
	for _, u := range a.users {
		if u.ExpiresAt.After(now) && (next.IsZero() || u.ExpiresAt.Before(next)) {
			next = u.ExpiresAt
		}
	}
	if next.IsZero() {
		return
	}
	d := next.Sub(now)
	if d > maxExpirySleep {
		d = maxExpirySleep
	}
	a.expiryTimer = time.AfterFunc(d, a.expiryDue)
}

// expiryDue is the timer's wake-up: render again (users past their term drop
// out) and reload the engine, or only write the file when no process is up for
// a signal; the supervisor's restart reads it.
func (a *Adapter) expiryDue() {
	a.mu.Lock()
	started, proc := a.started, a.proc
	a.mu.Unlock()
	if !started {
		return
	}
	if !a.configOnly() && (proc == nil || !proc.Running()) {
		a.restartMu.Lock()
		_, err := a.renderAndWrite()
		a.restartMu.Unlock()
		if err != nil {
			a.logger.Error("mtprotoproxy: expiry render failed", "err", err)
		}
		a.scheduleExpiry()
		return
	}
	if err := a.regenerateAndReload(context.Background()); err != nil {
		a.logger.Error("mtprotoproxy: reload at a user's term failed", "err", err)
	}
}

// stderrLevel: python's logging writes everything to stderr, the routine
// notice of a SIGUSR2 reload included; that one is not an error.
func stderrLevel(line string) slog.Level {
	if strings.Contains(line, "Config reloaded") {
		return slog.LevelInfo
	}
	return slog.LevelError
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
