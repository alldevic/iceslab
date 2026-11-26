package mtprotoproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newTestAdapter(t *testing.T) *Adapter {
	t.Helper()
	// No PythonPath: config-only mode, so nothing is spawned and the tests
	// exercise the state machine rather than a subprocess.
	return New(Config{
		ConfigPath: filepath.Join(t.TempDir(), "config.py"),
		Inbound:    InboundConfig{Domain: "www.cloudflare.com", ListenPort: 2083},
	}, quiet())
}

func TestAddUserRefusesAUserWithNoSecret(t *testing.T) {
	// Generating one here would produce a user who exists on the node and cannot
	// connect, because the link the buyer holds carries the panel's secret.
	a := newTestAdapter(t)
	err := a.AddUser(core.User{UserID: "u1"})
	if err == nil {
		t.Fatal("accepted a user with no MtprotoSecret")
	}
	if !strings.Contains(err.Error(), "MtprotoSecret") {
		t.Errorf("error should name the missing field, got %v", err)
	}
	if len(a.users) != 0 {
		t.Error("the rejected user was still recorded")
	}
}

func TestAddUserRefusesAMalformedSecret(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: "not-hex"}); err == nil {
		t.Fatal("accepted a secret that is not 32 hex chars")
	}
	if len(a.users) != 0 {
		t.Error("the rejected user was still recorded")
	}
}

func TestUserSetRoundTrip(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	users := runPy(t, blob)["USERS"].(map[string]any)
	if users["u1"] != secretA || users["u2"] != secretB {
		t.Errorf("USERS on disk = %v", users)
	}

	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(a.cfg.ConfigPath)
	users = runPy(t, blob)["USERS"].(map[string]any)
	if _, still := users["u1"]; still {
		t.Errorf("removed user still in USERS: %v", users)
	}
	if users["u2"] != secretB {
		t.Errorf("removing one user disturbed another: %v", users)
	}
}

func TestRepeatedPushDoesNotTriggerAReload(t *testing.T) {
	// The panel re-pushes the same user set routinely. Treating that as a change
	// would SIGUSR2 the process every time.
	//
	// Note what is NOT asserted: that the file is left alone. The config is
	// rewritten every time, atomically, because skipping the write would be
	// indistinguishable from an unsafe in-place rewrite (see the write contract
	// in internal/core). Only the reload is skipped.
	a := newTestAdapter(t)
	u := core.User{UserID: "u1", MtprotoSecret: secretA}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	changed, err := a.renderAndWrite()
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("an unchanged user set was reported as a change; the proxy would be signalled for nothing")
	}
	second, _ := os.ReadFile(a.cfg.ConfigPath)
	if string(first) != string(second) {
		t.Error("the same user set rendered differently twice")
	}

	// Removing somebody who is not there is a no-op too.
	if err := a.RemoveUser("nobody"); err != nil {
		t.Fatal(err)
	}
}

func TestAChangedUserSetIsReportedAsAChange(t *testing.T) {
	// The mirror of the test above: if this stopped reporting true, no reload
	// would ever fire and a new user would exist only in the file.
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.users["u2"] = User{Name: "u2", Secret: secretB}
	a.mu.Unlock()
	if changed, err := a.renderAndWrite(); err != nil || !changed {
		t.Errorf("adding a user reported changed=%v, err=%v; want true, nil", changed, err)
	}
}

func TestApplyInboundRequiresDomainAndIgnoresInboundSecret(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.ApplyInbound(2083, json.RawMessage(`{}`)); err == nil {
		t.Error("accepted an inbound with no domain")
	}
	// The panel still sends the mtg-shaped `secret`; on this engine the secret
	// belongs to the user. Accepting and ignoring it is what lets a node move to
	// this engine before the panel side changes.
	err := a.ApplyInbound(2083, json.RawMessage(`{"domain":"example.org","secret":"eedead"}`))
	if err != nil {
		t.Fatalf("ApplyInbound with an inbound secret field: %v", err)
	}
	if a.cfg.Inbound.Domain != "example.org" {
		t.Errorf("domain = %q", a.cfg.Inbound.Domain)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	if strings.Contains(string(blob), "eedead") {
		t.Error("the inbound-level secret leaked into the generated config")
	}
}

func TestTheInboundPortIsTheOneRendered(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.ApplyInbound(8443, json.RawMessage(`{"domain":"example.org"}`)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	if got := runPy(t, blob)["PORT"].(float64); got != 8443 {
		t.Errorf("PORT = %v, want the inbound's 8443", got)
	}
	// Port 0 keeps the one the agent has.
	if err := a.ApplyInbound(0, json.RawMessage(`{"domain":"example.net"}`)); err != nil {
		t.Fatal(err)
	}
	if a.cfg.Inbound.ListenPort != 8443 {
		t.Errorf("port 0 replaced the port: %d", a.cfg.Inbound.ListenPort)
	}
}

func TestRevokingSomeoneWeNeverHadIsQuiet(t *testing.T) {
	// The panel takes a user off every adapter its push does not name, so the
	// ordinary case is "not entitled, not held". That must cost nothing: a
	// reload per unentitled person per sync would restart the proxy continuously.
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("revoking a user the adapter never held rewrote the config")
	}
	if len(a.users) != 1 {
		t.Errorf("the untouched user went missing: %v", a.users)
	}
}

func TestUsersWaitInMemoryUntilThereIsAnInbound(t *testing.T) {
	// The panel adds its users to every adapter of a node, configured or not.
	a := New(Config{ConfigPath: filepath.Join(t.TempDir(), "config.py")}, quiet())
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatalf("AddUser on an unprovisioned adapter: %v", err)
	}
	if _, err := os.Stat(a.cfg.ConfigPath); err == nil {
		t.Error("wrote a config for an adapter with no inbound")
	}
	if err := a.ApplyInbound(2083, json.RawMessage(`{"domain":"example.org"}`)); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	if users := runPy(t, blob)["USERS"].(map[string]any); users["u1"] != secretA {
		t.Errorf("the waiting user did not reach the config: %v", users)
	}
}

func TestAFailedApplyIsRetried(t *testing.T) {
	// Committing the remembered config before the work that can fail turns one
	// failure into a permanent one: the next identical push compares equal, logs
	// "config unchanged, skipping", and the adapter never tries again.
	if os.Getuid() == 0 {
		t.Skip("root writes into a read-only directory")
	}
	dir := t.TempDir()
	unwritable := filepath.Join(dir, "nope")
	if err := os.Mkdir(unwritable, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(unwritable, 0o700) })

	a := New(Config{
		ConfigPath: filepath.Join(unwritable, "config.py"),
		Inbound:    InboundConfig{ListenPort: 2083},
	}, quiet())

	cfg := json.RawMessage(`{"domain":"www.cloudflare.com"}`)
	if err := a.ApplyInbound(2083, cfg); err == nil {
		t.Fatal("a write to a read-only directory should have failed")
	}
	// The state must NOT have been kept, or the retry below is a no-op.
	if a.cfg.Inbound.Domain != "" {
		t.Errorf("the failed apply kept its config: domain = %q", a.cfg.Inbound.Domain)
	}
	if err := os.Chmod(unwritable, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(2083, cfg); err != nil {
		t.Fatalf("the retry after fixing the cause failed: %v", err)
	}
	if _, err := os.Stat(a.cfg.ConfigPath); err != nil {
		t.Errorf("the retry was skipped as unchanged; no config was written: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The crypto guard
// ─────────────────────────────────────────────────────────────────────────────

func TestRefusesToStartOnTheSlowCryptoBackend(t *testing.T) {
	// Measured on the target node: pyaes does 0.4 MB/s against cryptography's
	// 3777 MB/s. mtprotoproxy starts anyway and prints a suggestion, so a proxy
	// carrying media at dial-up speed would report itself healthy.
	failing := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("pyaes\n"), errors.New("exit status 1")
	}
	err := assertFastCrypto(context.Background(), failing, "python3")
	if err == nil {
		t.Fatal("started on the bundled pyaes backend")
	}
	if !strings.Contains(err.Error(), "python3-cryptography") {
		t.Errorf("the error should say what to install, got: %v", err)
	}
}

func TestAcceptsAFastCryptoBackend(t *testing.T) {
	ok := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("cryptography\n"), nil
	}
	if err := assertFastCrypto(context.Background(), ok, "python3"); err != nil {
		t.Fatalf("refused a working backend: %v", err)
	}
}

func TestCryptoProbeMatchesRealPython(t *testing.T) {
	// The probe mirrors mtprotoproxy's own selection order, so it is worth
	// running against a real interpreter rather than only a stub: a syntax error
	// in the probe would fail every start with a message about crypto.
	runPy(t, []byte("")) // skips when there is no python3
	var seen string
	spy := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		out, err := defaultRunCmd(ctx, name, args...)
		seen = strings.TrimSpace(string(out))
		return out, err
	}
	err := assertFastCrypto(context.Background(), spy, "python3")
	if seen != "cryptography" && seen != "pycryptodome" && seen != "pyaes" {
		t.Fatalf("the probe printed %q, expected one of the three backend names (err %v)", seen, err)
	}
	if (seen == "pyaes") != (err != nil) {
		t.Errorf("backend %q but assertFastCrypto said %v", seen, err)
	}
}

func TestASlowBackendAtStartIsAFaultNotACrash(t *testing.T) {
	// A refused start at boot must not take the agent (and every other core)
	// down with it; /healthz says why through Fault, and a push still gets the
	// error.
	slow := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("pyaes\n"), errors.New("exit status 1")
	}
	cfgPath := filepath.Join(t.TempDir(), "config.py")
	a := New(Config{
		PythonPath: "/bin/sh", ScriptPath: "/bin/true", ConfigPath: cfgPath, RunCmd: slow,
		Inbound: InboundConfig{Domain: "www.cloudflare.com", ListenPort: 2083},
	}, quiet())
	t.Cleanup(func() { _ = a.Stop(context.Background()) })

	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a refused backend, got %v", err)
	}
	if !strings.Contains(a.Fault(), "python3-cryptography") {
		t.Errorf("Fault() = %q, want the reason and what to install", a.Fault())
	}
	if a.Healthy() {
		t.Error("a core that was never spawned reports healthy")
	}
	if _, err := os.Stat(cfgPath); err == nil {
		t.Error("a refused start still wrote a config")
	}
	err := a.ApplyInbound(2083, json.RawMessage(`{"domain":"example.org"}`))
	if !errors.Is(err, errSlowCrypto) {
		t.Fatalf("push on a slow backend: want the refusal, got %v", err)
	}
	if a.cfg.Inbound.Domain != "www.cloudflare.com" {
		t.Errorf("the refused push kept its domain: %q", a.cfg.Inbound.Domain)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The process: a stand-in script run by /bin/sh as the "python".
// ─────────────────────────────────────────────────────────────────────────────

type fixture struct {
	a                       *Adapter
	marker, starts, signals string
}

func (f fixture) count(t *testing.T, path, word string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Count(string(b), word+"\n")
}

func (f fixture) waitSignals(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for f.count(t, f.signals, "usr2") < want {
		if time.Now().After(deadline) {
			t.Fatalf("the process saw %d signals, want %d", f.count(t, f.signals, "usr2"), want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// processFixture: a script that logs every real run to starts and every SIGUSR2
// to signals, and dies at once unless the marker file exists (a taken port).
func processFixture(t *testing.T, stayUp bool) fixture {
	t.Helper()
	dir := t.TempDir()
	f := fixture{
		marker:  filepath.Join(dir, "stay-up"),
		starts:  filepath.Join(dir, "starts"),
		signals: filepath.Join(dir, "signals"),
	}
	script := filepath.Join(dir, "mtprotoproxy.sh")
	body := "echo run >> '" + f.starts + "'\n" +
		"if [ ! -e '" + f.marker + "' ]; then echo 'address already in use' >&2; exit 1; fi\n" +
		"trap 'echo usr2 >> " + f.signals + "' USR2\n" +
		"while :; do sleep 0.05; done\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	if stayUp {
		if err := os.WriteFile(f.marker, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ok := func(context.Context, string, ...string) ([]byte, error) { return []byte("cryptography\n"), nil }
	f.a = New(Config{
		PythonPath: "/bin/sh", ScriptPath: script, ConfigPath: filepath.Join(dir, "config.py"),
		Inbound: InboundConfig{ListenPort: 2083}, RunCmd: ok,
	}, quiet())
	t.Cleanup(func() { _ = f.a.Stop(context.Background()) })
	return f
}

var domainPush = json.RawMessage(`{"domain":"www.cloudflare.com"}`)

func TestUsersAreReloadedByOneSignalAndNoRestart(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if !a.Healthy() || a.Fault() != "" {
		t.Fatalf("a live core: healthy %v fault %q", a.Healthy(), a.Fault())
	}
	time.Sleep(150 * time.Millisecond) // let the trap be installed

	u1 := core.User{UserID: "u1", MtprotoSecret: secretA}
	if err := a.AddUser(u1); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 1)
	// The same set again: no signal.
	if err := a.AddUser(u1); err != nil {
		t.Fatal(err)
	}
	if err := a.RemoveUser("nobody"); err != nil {
		t.Fatal(err)
	}
	// A changed one: exactly one more.
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 2)
	time.Sleep(200 * time.Millisecond)
	if n := f.count(t, f.signals, "usr2"); n != 2 {
		t.Errorf("the process saw %d signals, want exactly 2", n)
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Errorf("the process ran %d times; a user change must not restart it", n)
	}
	// The same domain and port pushed again: nothing happens either.
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Errorf("an identical inbound push restarted the process: %d runs", n)
	}
}

func TestAChangedDomainOrPortRestartsTheProcess(t *testing.T) {
	f := processFixture(t, true)
	if err := f.a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if err := f.a.ApplyInbound(2085, domainPush); err != nil {
		t.Fatal(err)
	}
	if err := f.a.ApplyInbound(2085, json.RawMessage(`{"domain":"example.org"}`)); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 3 {
		t.Errorf("a port change and a domain change ran the process %d times in all, want 3", n)
	}
}

func TestADeadProcessIsStartedAgainByTheNextUser(t *testing.T) {
	// The signal cannot be delivered to a process that is not there; the user set
	// must not be lost with it, so the adapter starts the process again.
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	// Stopped by hand: the supervisor will not respawn it.
	if err := proc.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatalf("AddUser on a dead core: %v", err)
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Errorf("the process ran %d times, want 2 (a restart in place of the lost signal)", n)
	}
	if !a.Healthy() {
		t.Error("the restarted core is not healthy")
	}
}

func TestApplyInbound_CoreThatDiesImmediatelyIsNotReportedAsStarted(t *testing.T) {
	f := processFixture(t, false)
	err := f.a.ApplyInbound(2083, domainPush)
	if !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("a core that exited at once: want the window error, got %v", err)
	}
	f.a.mu.Lock()
	failed := f.a.lastStartFailed
	f.a.mu.Unlock()
	if !failed {
		t.Error("lastStartFailed not set")
	}
	if f.a.Fault() == "" {
		t.Error("Fault() is empty, the panel would be told the core left no reason")
	}
	if f.a.Healthy() {
		t.Error("a core that died on spawn reports healthy")
	}
	if !f.a.Provisioned() {
		t.Error("a core that started and died must stay configured: the push is retried by the same config")
	}
}

func TestApplyInbound_RepeatPushAfterAStartupDeathStartsTheCoreAgain(t *testing.T) {
	f := processFixture(t, false)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err == nil {
		t.Fatal("first push: want an error")
	}
	if err := a.ApplyInbound(2083, domainPush); err == nil {
		t.Fatal("identical push with a core that dies again: want an error")
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Fatalf("an identical push while the core was down ran it %d times, want 2", n)
	}
	if err := os.WriteFile(f.marker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatalf("identical push with a core that stays up: %v", err)
	}
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 3 {
		t.Fatalf("the core ran %d times in all, want 3 (an identical push after success is skipped)", n)
	}
}

func TestStart_CoreThatDiesAtBootKeepsTheAgentUp(t *testing.T) {
	f := processFixture(t, false)
	a := f.a
	a.cfg.Inbound.Domain = "www.cloudflare.com"
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must tolerate a death inside the window, got %v", err)
	}
	if a.Fault() == "" || a.Healthy() {
		t.Errorf("a dead core: fault %q healthy %v", a.Fault(), a.Healthy())
	}
	err := a.ApplyInbound(2083, json.RawMessage(`{"domain":"www.cloudflare.com"}`))
	if !errors.Is(err, subprocess.ErrDiedInStartup) {
		t.Fatalf("push after a boot death: want the window error, got %v", err)
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Errorf("the push did not start the core again: %d runs, want 2", n)
	}
}

func TestIdleStopsTheProcessAndTheSameInboundBringsItBack(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.Healthy() || a.Provisioned() {
		t.Errorf("after Idle: healthy %v provisioned %v", a.Healthy(), a.Provisioned())
	}
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if !a.Healthy() {
		t.Error("the same inbound pushed again did not bring it back")
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Errorf("ran %d times, want 2", n)
	}
}

func TestStatsListHeldUsersOnlyWhileServing(t *testing.T) {
	// Until the metrics scrape (8.4) this answers as mtg does: the roster with
	// zero counters while the core serves, nothing at all while it does not (A-121).
	f := processFixture(t, true)
	a := f.a
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	if st, err := a.GetStats(); err != nil || len(st.Users) != 0 || st.NoData {
		t.Fatalf("not serving: %v %+v, want an empty report", err, st)
	}
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	st, err := a.GetStats()
	if err != nil || st.NoData || len(st.Users) != 1 || st.Users[0].UserID != "u1" ||
		st.Users[0].BytesIn != 0 || st.TotalBytesIn != 0 {
		t.Fatalf("serving: %v %+v", err, st)
	}
	if a.CountsUsers() {
		t.Error("CountsUsers is true before there is a scrape to count with")
	}
}

func TestRestartsAreTalliedAndAPortIsReserved(t *testing.T) {
	a := newTestAdapter(t)
	if st := a.RestartStats(); st.Crash != 0 || st.SinceAt.IsZero() {
		t.Fatalf("a fresh adapter: %+v", st)
	}
	a.restarts.Record(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, At: time.Now()})
	if st := a.RestartStats(); st.Crash != 1 {
		t.Errorf("crash = %d, want 1", st.Crash)
	}
	ports := a.ReservedPorts()
	if len(ports) != 1 || ports[0].Port != 3130 {
		t.Errorf("ReservedPorts = %+v, want the metrics port 3130 (mtg keeps 3129)", ports)
	}
	if a.Installed() {
		t.Error("config-only mode has no script on the machine")
	}
	if a.Engine() != "mtprotoproxy" || a.Name() != "mtproto" {
		t.Errorf("routing key = %s/%s", a.Name(), a.Engine())
	}
}
