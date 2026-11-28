package mtprotoproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
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

// A push without an MTProto secret is not for this engine. The panel hands one
// credential blob to every adapter (a WireGuard device, a user of another core),
// and an error here would turn that user's result into a failure on a node that
// runs this engine. (Until f07-10 this was TestAddUserRefusesAUserWithNoSecret:
// it asserted the opposite, a guard against a real MTProto user arriving
// secretless, which the panel's unconditional derivation rules out.)
func TestAPushWithNoMtprotoSecretIsNotOurs(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1"}); err != nil {
		t.Fatalf("a secretless push is not ours, and not an error: %v", err)
	}
	if len(a.users) != 0 {
		t.Error("a secretless push changed the user set")
	}
	cfg, _ := os.ReadFile(a.cfg.ConfigPath)
	if len(cfg) != 0 {
		t.Errorf("a secretless push wrote the config:\n%s", cfg)
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
		Inbound: InboundConfig{ListenPort: 2083}, RunCmd: ok, ReadyAfter: time.Millisecond,
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
	// The roster is reported while the core serves, nothing at all while it does
	// not (A-121).
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "mtprotoproxy_connects 3\n")
	}))
	defer srv.Close()
	f := processFixture(t, true)
	a := f.a
	a.cfg.MetricsURL = srv.URL
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
	if !a.CountsUsers() {
		t.Error("CountsUsers is false: this engine attributes bytes to a user")
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

// A python that installs its USR2 handler only after a delay: a signal before
// it is the process's death (the default action), as on the stand.
func lateHandlerAdapter(t *testing.T, delay time.Duration, readyAfter time.Duration) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	signals := filepath.Join(dir, "signals")
	script := filepath.Join(dir, "mtprotoproxy.sh")
	body := "sleep " + strconv.FormatFloat(delay.Seconds(), 'f', 2, 64) + "\n" +
		"trap 'echo usr2 >> " + signals + "' USR2\n" +
		"while :; do sleep 0.05; done\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	ok := func(context.Context, string, ...string) ([]byte, error) { return []byte("cryptography\n"), nil }
	a := New(Config{
		PythonPath: "/bin/sh", ScriptPath: script, ConfigPath: filepath.Join(dir, "config.py"),
		Inbound: InboundConfig{ListenPort: 2083}, RunCmd: ok, ReadyAfter: readyAfter,
	}, quiet())
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	return a, signals
}

func TestTheFirstUserRightAfterStartDoesNotKillTheProcess(t *testing.T) {
	a, signals := lateHandlerAdapter(t, 700*time.Millisecond, 1200*time.Millisecond)
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if !a.Healthy() {
		t.Fatal("the signal reached the process before its handler and killed it")
	}
	if b, _ := os.ReadFile(signals); !strings.Contains(string(b), "usr2") {
		t.Error("the user was written but the process was never told to re-read")
	}
	if n := a.RestartStats().Crash; n != 0 {
		t.Errorf("the process was restarted %d times", n)
	}
}

func TestRemovingTheLastUserKeepsTheProcessAndTheNextAddReloadsIt(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 1) // the shell coalesces signals that arrive together
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 2)
	if !a.Healthy() || !a.Provisioned() {
		t.Fatalf("an inbound with no users stopped: healthy %v provisioned %v", a.Healthy(), a.Provisioned())
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 3)
	b, _ := os.ReadFile(a.cfg.ConfigPath)
	if !strings.Contains(string(b), secretA) {
		t.Error("the new user is not in the config the process reloads")
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Errorf("ran %d times, want 1 (no push, no restart)", n)
	}
}

func TestReloadNoticeOnStderrIsNotAnError(t *testing.T) {
	if stderrLevel("Config reloaded") != slog.LevelInfo || stderrLevel("address already in use") != slog.LevelError {
		t.Error("stderr line classification")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Seamless switch off mtg.
//
// A tg:// link is not a subscription: the client stored a server, a port and a
// secret, and there is nothing for it to re-fetch. On the day mtg stops, every
// buyer's saved entry either still works or does not. Carrying mtg's one shared
// secret as an extra user is what makes it still work.
// ─────────────────────────────────────────────────────────────────────────────

// The mtg secret of a deployment, shape and all:
// "ee" + 16 raw bytes + hex("www.cloudflare.com").
const liveMtgSecret = "eed06ba72cc5f27206cb632a62a7b3865c7777772e636c6f7564666c6172652e636f6d"
const liveMtgRaw = "d06ba72cc5f27206cb632a62a7b3865c"
const liveDomain = "www.cloudflare.com"

func legacyAdapter(t *testing.T, accept bool) *Adapter {
	t.Helper()
	return New(Config{
		ConfigPath: filepath.Join(t.TempDir(), "config.py"),
		// No Domain: it arrives from the panel, which makes the ApplyInbound
		// below a real change rather than a no-op the adapter correctly skips.
		Inbound:            InboundConfig{ListenPort: 2083},
		AcceptLegacySecret: accept,
	}, quiet())
}

func configOf(t *testing.T, a *Adapter) []byte {
	t.Helper()
	b, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestOldMtgLinksKeepWorkingDuringMigration(t *testing.T) {
	a := legacyAdapter(t, true)
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	users := runPy(t, configOf(t, a))["USERS"].(map[string]any)

	// The raw half of mtg's secret, under the migration name. mtprotoproxy
	// rebuilds "ee" + this + hex(TLS_DOMAIN), byte for byte the secret already
	// saved in every buyer's Telegram.
	if users[LegacyUserName] != liveMtgRaw {
		t.Errorf("legacy secret missing or wrong: %v", users)
	}
	if users["u1"] != secretA {
		t.Errorf("the personal secret was disturbed: %v", users)
	}
}

func TestLegacySecretIsOffUnlessAskedFor(t *testing.T) {
	// It keeps alive a secret everybody has and nobody owns, so it is a
	// deliberate migration state, not something a node drifts into.
	a := legacyAdapter(t, false)
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(configOf(t, a)), liveMtgRaw) || strings.Contains(string(configOf(t, a)), LegacyUserName) {
		t.Error("the legacy secret was carried without the flag being set")
	}
}

func TestLegacySecretForAnotherDomainIsRefused(t *testing.T) {
	// The domain is baked into the FakeTLS secret, so a secret minted for
	// another one could not be accepted anyway. Carrying it would look like
	// migration cover while providing none.
	a := legacyAdapter(t, true)
	other := "ee" + liveMtgRaw + "6578616d706c652e636f6d" // example.com
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+other+`"}`)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(configOf(t, a)), liveMtgRaw) {
		t.Error("a secret for another domain was carried as cover")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats (metrics scrape) and the version file
// ─────────────────────────────────────────────────────────────────────────────

func metricsServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if status != 0 {
			w.WriteHeader(status)
		}
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestGetStatsAttributesTrafficPerUser(t *testing.T) {
	srv := metricsServer(t, `mtprotoproxy_user_octets_from{user="u1"} 100
mtprotoproxy_user_octets_to{user="u1"} 200
mtprotoproxy_user_octets_from{user="u2"} 5
mtprotoproxy_user_octets_to{user="u2"} 7
`, 0)
	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})
	a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB})

	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Cumulative {
		t.Error("counters are cumulative since process start; the panel must diff them")
	}
	if len(st.Users) != 2 {
		t.Fatalf("users = %d", len(st.Users))
	}
	byID := map[string]int64{}
	for _, u := range st.Users {
		byID[u.UserID+"/in"] = u.BytesIn
		byID[u.UserID+"/out"] = u.BytesOut
	}
	if byID["u1/in"] != 100 || byID["u1/out"] != 200 || byID["u2/in"] != 5 || byID["u2/out"] != 7 {
		t.Errorf("per-user attribution wrong: %v", byID)
	}
	if st.TotalBytesIn != 105 || st.TotalBytesOut != 207 {
		t.Errorf("totals = %d/%d, want 105/207", st.TotalBytesIn, st.TotalBytesOut)
	}
}

func TestGetStatsMarksNoDataRatherThanReportingZeros(t *testing.T) {
	// A zero is indistinguishable from "nobody used it": the counter would read
	// as dropping to 0 and the next good poll would bill all of it at once.
	srv := metricsServer(t, "", http.StatusInternalServerError)
	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})

	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if !st.NoData {
		t.Error("a failed scrape must set NoData")
	}
	if len(st.Users) != 0 {
		t.Error("a failed scrape must not report user rows at all")
	}
}

func TestKnownUserWithNoRowReportsZero(t *testing.T) {
	// The endpoint answered and did not mention them: they have not used the
	// proxy since it started. That is a real zero, unlike a failed scrape.
	srv := metricsServer(t, "mtprotoproxy_connects 3\n", 0)
	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})

	st, _ := a.GetStats()
	if st.NoData {
		t.Error("a successful scrape with no rows is not NoData")
	}
	if len(st.Users) != 1 || st.Users[0].BytesIn != 0 {
		t.Errorf("users = %+v", st.Users)
	}
}

func TestLegacyUserIsNotReportedToThePanel(t *testing.T) {
	// It is not a panel user. Handing the panel a userId it has never heard of
	// would risk the whole stats poll for a row nobody can be billed for; the
	// operator watches this cohort on the node's metrics endpoint instead.
	srv := metricsServer(t, `mtprotoproxy_user_octets_from{user="`+LegacyUserName+`"} 900
mtprotoproxy_user_octets_from{user="u1"} 5
mtprotoproxy_user_octets_to{user="u1"} 7
`, 0)
	a := legacyAdapter(t, true)
	a.cfg.MetricsURL = srv.URL
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range st.Users {
		if u.UserID == LegacyUserName {
			t.Fatal("the legacy cohort was reported to the panel as a user")
		}
	}
	if len(st.Users) != 1 || st.Users[0].UserID != "u1" {
		t.Errorf("users = %+v", st.Users)
	}
	// It still lands in the NODE totals: nobody can be billed for it, but it is
	// real traffic, and a node mid-migration must not look quieter than it is.
	if st.TotalBytesIn != 900+5 {
		t.Errorf("TotalBytesIn = %d, want 905 (the legacy cohort plus u1)", st.TotalBytesIn)
	}
}

func TestRevokingAUserDoesNotDentTheNodeTotal(t *testing.T) {
	// The panel reads the node total as a cumulative counter and treats a DROP
	// as a core restart worth re-baselining. mtprotoproxy keeps a departed
	// user's counters in its stats after they leave USERS, so the scrape still
	// carries them; summing only the CURRENT users would make every revocation
	// look like a restart.
	srv := metricsServer(t, `mtprotoproxy_user_octets_from{user="stays"} 100
mtprotoproxy_user_octets_to{user="stays"} 200
mtprotoproxy_user_octets_from{user="revoked"} 1000
mtprotoproxy_user_octets_to{user="revoked"} 2000
`, 0)
	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	if err := a.AddUser(core.User{UserID: "stays", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	// "revoked" is gone from USERS but still in the scrape.
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Users) != 1 || st.Users[0].UserID != "stays" {
		t.Errorf("a revoked user must not be attributed: %+v", st.Users)
	}
	if st.TotalBytesIn != 1100 || st.TotalBytesOut != 2200 {
		t.Errorf("node totals = %d/%d, want 1100/2200: the departed user's bytes still happened",
			st.TotalBytesIn, st.TotalBytesOut)
	}
}

func TestCoreVersionIsWhatTheBootstrapWrote(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "mtprotoproxy.py")
	a := New(Config{ScriptPath: script, ConfigPath: filepath.Join(dir, "config.py")}, quiet())

	// Not installed: no script, no file.
	if v := a.CoreVersion(); v != "" {
		t.Errorf("not installed: version %q, want empty", v)
	}
	// A tree put there by hand: no version file.
	if err := os.WriteFile(script, []byte("#"), 0o644); err != nil {
		t.Fatal(err)
	}
	if v := a.CoreVersion(); v != "" {
		t.Errorf("no version file: version %q, want empty", v)
	}
	if err := os.WriteFile(filepath.Join(dir, VersionFile), []byte("1.1.2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if v := a.CoreVersion(); v != "1.1.2" {
		t.Errorf("version = %q, want 1.1.2", v)
	}
	// Config-only mode (no script configured) has nothing to read.
	if v := New(Config{}, quiet()).CoreVersion(); v != "" {
		t.Errorf("no script path: version %q, want empty", v)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The backstops: a term and a traffic quota that the node itself enforces, for
// the time the panel cannot reach it. The panel's accounting stays the primary
// one; on mtg an expired or exhausted buyer simply kept working.
// ─────────────────────────────────────────────────────────────────────────────

func quota(n int64) *int64 { return &n }

func configPy(t *testing.T, a *Adapter) map[string]any {
	t.Helper()
	return runPy(t, configOf(t, a))
}

func quotaOf(t *testing.T, a *Adapter, user string) (float64, bool) {
	t.Helper()
	m, ok := configPy(t, a)["USER_DATA_QUOTA"].(map[string]any)
	if !ok {
		return 0, false
	}
	v, ok := m[user].(float64)
	return v, ok
}

func TestExpiryAndQuotaReachTheConfig(t *testing.T) {
	a := newTestAdapter(t)
	a.cfg.Now = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	a.cfg.Inbound.zone = time.UTC
	err := a.AddUser(core.User{
		UserID:            "u1",
		MtprotoSecret:     secretA,
		MtprotoExpiresAt:  time.Date(2026, 10, 4, 15, 35, 0, 0, time.UTC),
		MtprotoQuotaBytes: quota(500 * 1024 * 1024 * 1024),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := configPy(t, a)
	// The day AFTER: mtprotoproxy cuts at 00:00 of the named date, so writing
	// 04/10 would end a term that runs to 15:35 about sixteen hours early. The
	// exact cut is the adapter's; this date is the net under it.
	if exp := got["USER_EXPIRATIONS"].(map[string]any); exp["u1"] != "05/10/2026" {
		t.Errorf("USER_EXPIRATIONS[u1] = %v, want 05/10/2026", exp["u1"])
	}
	// No process, so no counter: the ceiling is the remainder as pushed.
	if q, _ := quotaOf(t, a, "u1"); int64(q) != 500*1024*1024*1024 {
		t.Errorf("USER_DATA_QUOTA[u1] = %v", q)
	}
}

func TestTheDateInTheConfigIsNotBeforeTheTermInTheNodesZone(t *testing.T) {
	// mtprotoproxy compares naive LOCAL times: the date names 00:00 of that day
	// on the node. Formatted in UTC (as the fork did) a node west of UTC cut the
	// user off hours early.
	for _, tz := range []*time.Location{
		time.FixedZone("west", -8*3600), time.UTC, time.FixedZone("east", 13*3600),
	} {
		for _, term := range []time.Time{
			time.Date(2026, 10, 4, 15, 35, 0, 0, time.UTC),
			time.Date(2026, 10, 4, 23, 59, 59, 0, time.UTC),
			time.Date(2026, 12, 31, 20, 0, 0, 0, time.UTC),
		} {
			in := baseInbound()
			in.zone = tz
			blob, err := renderConfig(in, []User{{Name: "u1", Secret: secretA, ExpiresAt: term}})
			if err != nil {
				t.Fatal(err)
			}
			d := runPy(t, blob)["USER_EXPIRATIONS"].(map[string]any)["u1"].(string)
			cut, err := time.ParseInLocation("02/01/2006", d, tz)
			if err != nil {
				t.Fatalf("%s: unparseable date %q", tz, d)
			}
			if cut.Before(term) {
				t.Errorf("zone %s, term %s: the engine would cut at %s, before the term", tz, term, cut)
			}
			if cut.Sub(term) > 48*time.Hour {
				t.Errorf("zone %s, term %s: the net %s is more than two days late", tz, term, cut)
			}
		}
	}
}

func TestNoLimitsMeansNoKeysAtAll(t *testing.T) {
	// A user on an unlimited plan must not acquire a quota or an expiry from a
	// zero value: mtprotoproxy treats a present key as a limit, so a zero would
	// read as "expired in year one" / "quota of nothing". The migration user is
	// no plan either.
	a := legacyAdapter(t, true)
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	got := configPy(t, a)
	if got["USERS"].(map[string]any)[LegacyUserName] == nil {
		t.Fatal("the legacy user is missing, the test proves nothing")
	}
	for _, k := range []string{"USER_EXPIRATIONS", "USER_DATA_QUOTA", "USER_MAX_TCP_CONNS"} {
		if _, present := got[k]; present {
			t.Errorf("%s emitted for users with no limits: %v", k, got[k])
		}
	}
}

func TestAQuotaSpentIsAQuotaOfNothingNotNoQuota(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(0)}); err != nil {
		t.Fatal(err)
	}
	if q, ok := quotaOf(t, a, "u1"); !ok || q != 0 {
		t.Errorf("a spent limit must be written as 0, got %v present=%v", q, ok)
	}
}

func TestANegativeQuotaIsRefused(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(-1)}); err == nil {
		t.Fatal("accepted a negative quota")
	}
	if _, err := renderConfig(baseInbound(), []User{{Name: "u1", Secret: secretA, Limited: true, QuotaBytes: -5}}); err == nil {
		t.Fatal("rendered a negative quota")
	}
}

func TestConnectionCapIsNeverSetByThePush(t *testing.T) {
	// USER_MAX_TCP_CONNS reads like a device limit and is not one: it caps
	// CONCURRENT connections, and one Telegram client holds several. A cap that
	// disconnects paying users is worse than no cap, so nothing on the wire
	// carries it.
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(1 << 20)}); err != nil {
		t.Fatal(err)
	}
	if _, present := configPy(t, a)["USER_MAX_TCP_CONNS"]; present {
		t.Error("the push set a connection cap; nothing on the wire should be able to")
	}
}

func TestChangingALimitReloadsAndDoesNotRestart(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond) // let the trap be installed
	u := core.User{
		UserID: "u1", MtprotoSecret: secretA,
		MtprotoExpiresAt:  time.Now().Add(48 * time.Hour),
		MtprotoQuotaBytes: quota(1000),
	}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 1)
	// A renewed term and a topped-up remainder are changes the node must hear.
	u.MtprotoExpiresAt = u.MtprotoExpiresAt.Add(30 * 24 * time.Hour)
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 2)
	u.MtprotoQuotaBytes = quota(5000)
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 3)
	if q, _ := quotaOf(t, a, "u1"); q != 5000 {
		t.Errorf("the new remainder is not in the config: %v", q)
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Errorf("a limit change restarted the process: %d runs", n)
	}
}

func TestAUserLeavesTheConfigAtTheirTermWithoutAPush(t *testing.T) {
	a := newTestAdapter(t)
	clock := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	a.cfg.Now = func() time.Time { return clock }
	term := clock.Add(time.Hour)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoExpiresAt: term}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	if _, ok := configPy(t, a)["USERS"].(map[string]any)["u1"]; !ok {
		t.Fatal("the user is missing before the term")
	}
	// One second before: still there. At the term: gone, with no push.
	clock = term.Add(-time.Second)
	if _, err := a.renderAndWrite(); err != nil {
		t.Fatal(err)
	}
	if _, ok := configPy(t, a)["USERS"].(map[string]any)["u1"]; !ok {
		t.Error("the user was cut a second early")
	}
	clock = term
	if _, err := a.renderAndWrite(); err != nil {
		t.Fatal(err)
	}
	users := configPy(t, a)["USERS"].(map[string]any)
	if _, ok := users["u1"]; ok {
		t.Error("the user is still served at their term")
	}
	if users["u2"] != secretB {
		t.Error("a user without a term was disturbed")
	}
}

func TestExtendingTheTermBringsTheUserBack(t *testing.T) {
	a := newTestAdapter(t)
	clock := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	a.cfg.Now = func() time.Time { return clock }
	u := core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoExpiresAt: clock.Add(-time.Minute)}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	if _, ok := configPy(t, a)["USERS"].(map[string]any)["u1"]; ok {
		t.Fatal("a user already past the term was written")
	}
	u.MtprotoExpiresAt = clock.Add(30 * 24 * time.Hour)
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	if _, ok := configPy(t, a)["USERS"].(map[string]any)["u1"]; !ok {
		t.Error("the renewed user did not come back")
	}
}

func TestTheTimerCutsAUserAtTheirTermAndReloadsTheEngine(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	term := time.Now().Add(700 * time.Millisecond)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoExpiresAt: term}); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 1)
	// Nobody pushes anything; the second signal is the timer's.
	f.waitSignals(t, 2)
	if time.Now().Before(term) {
		t.Error("the engine was told before the term")
	}
	if _, ok := configPy(t, a)["USERS"].(map[string]any)["u1"]; ok {
		t.Error("the user is still in the config after the term")
	}
	if n := f.count(t, f.starts, "run"); n != 1 {
		t.Errorf("the cut restarted the process: %d runs", n)
	}
}

func TestAStoppedAdapterIsNotWokenByATerm(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA,
		MtprotoExpiresAt: time.Now().Add(400 * time.Millisecond)}); err != nil {
		t.Fatal(err)
	}
	f.waitSignals(t, 1)
	if err := a.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := configOf(t, a)
	time.Sleep(900 * time.Millisecond)
	if string(configOf(t, a)) != string(before) {
		t.Error("the timer fired on a stopped adapter and rewrote the config")
	}
	a.mu.Lock()
	armed := a.expiryTimer != nil
	a.mu.Unlock()
	if armed {
		t.Error("the term timer is still armed after Stop")
	}
}

// counters serves a movable scrape body.
type counters struct {
	srv  *httptest.Server
	body atomic.Value
}

func newCounters(t *testing.T) *counters {
	t.Helper()
	c := &counters{}
	c.body.Store("")
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, c.body.Load().(string))
	}))
	t.Cleanup(c.srv.Close)
	return c
}

// set: the user's counter, as the engine would export it.
func (c *counters) set(user string, total int64) {
	c.body.Store(`mtprotoproxy_user_octets_from{user="` + user + `"} ` + strconv.FormatInt(total/2, 10) + "\n" +
		`mtprotoproxy_user_octets_to{user="` + user + `"} ` + strconv.FormatInt(total-total/2, 10) + "\n")
}

func TestTheQuotaIsTheCounterPlusTheRemainder(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	c := newCounters(t)
	a.cfg.MetricsURL = c.srv.URL
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)

	// The user has already carried 400 bytes in this process when the push comes.
	c.set("u1", 400)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(1000)}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 1400 {
		t.Fatalf("quota = %v, want counter 400 + remainder 1000", q)
	}

	// Traffic moves on and an unrelated push re-renders: the ceiling must not
	// move with it, or the allowance would be handed out again at every render.
	c.set("u1", 700)
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 1400 {
		t.Errorf("a re-render moved the ceiling to %v", q)
	}

	// The panel catches up and pushes the real remainder: counter 700 + 150.
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(150)}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 850 {
		t.Errorf("quota = %v, want counter 700 + remainder 150", q)
	}
}

func TestAFailedReadDoesNotCutAUserEarly(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	c := newCounters(t)
	a.cfg.MetricsURL = c.srv.URL
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	c.set("u1", 400)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(1000)}); err != nil {
		t.Fatal(err)
	}
	c.srv.Close() // the scrape now fails
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q < 1400 {
		t.Errorf("an unreadable counter lowered the ceiling to %v: the user would be cut before the allowance", q)
	}
}

func TestAfterARestartTheQuotaIsTheRemainderNotTheLimit(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	c := newCounters(t)
	a.cfg.MetricsURL = c.srv.URL
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(1000)}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 1000 {
		t.Fatalf("quota = %v, want 1000", q)
	}
	// 400 bytes pass, the poll sees them.
	c.set("u1", 400)
	if _, err := a.GetStats(); err != nil {
		t.Fatal(err)
	}
	// The listener's port changes: a real restart, and the counters start over.
	if err := a.ApplyInbound(2085, domainPush); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, f.starts, "run"); n != 2 {
		t.Fatalf("expected a restart, runs = %d", n)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 600 {
		t.Errorf("after the restart the quota is %v; the user has 600 left, not the full 1000", q)
	}
	// And the new process counts from zero: its first counters are settled
	// against that, not against the old 400.
	c.set("u1", 100)
	if _, err := a.GetStats(); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 600 {
		t.Errorf("quota = %v after 100 more bytes in the new process, want the same 600 ceiling (100 + 500)", q)
	}
}

func TestACrashRestartDoesNotHandTheAllowanceBackEither(t *testing.T) {
	// The supervisor respawns a dead process on the config already on disk. That
	// file holds counter + remainder for the OLD counter; the new process starts
	// at zero, so without a rewrite the user would get the allowance a second time.
	f := processFixture(t, true)
	a := f.a
	c := newCounters(t)
	a.cfg.MetricsURL = c.srv.URL
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(1000)}); err != nil {
		t.Fatal(err)
	}
	c.set("u1", 700)
	if _, err := a.GetStats(); err != nil { // the poll that sees the 700
		t.Fatal(err)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 1000 {
		t.Fatalf("quota = %v before the crash, want 1000", q)
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if err := proc.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for f.count(t, f.starts, "run") < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the supervisor did not respawn the process")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 300 {
		t.Errorf("quota = %v after the crash-restart, want the remaining 300", q)
	}
}

// The quota backstop must not depend on the panel's polls: it exists for the
// panel being out of reach.
// startAdapter brings the adapter up: a fixture adapter has no inbound yet, the
// config-only one is born with it.
func startAdapter(t *testing.T, a *Adapter) {
	t.Helper()
	var err error
	if a.Provisioned() {
		err = a.Start(context.Background())
	} else {
		err = a.ApplyInbound(2083, domainPush)
	}
	if err != nil {
		t.Fatal(err)
	}
}

func quotaAdapter(t *testing.T, a *Adapter, c *counters, limit int64) {
	t.Helper()
	a.cfg.MetricsURL = c.srv.URL
	a.cfg.QuotaPollEvery = 50 * time.Millisecond
	startAdapter(t, a)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(limit)}); err != nil {
		t.Fatal(err)
	}
}

func lastSeen(a *Adapter) (last, remaining int64, running bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if tr := a.track["u1"]; tr != nil {
		last, remaining = tr.last, tr.remaining
	}
	return last, remaining, a.quotaStop != nil
}

func waitLast(t *testing.T, a *Adapter, want int64) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if l, _, _ := lastSeen(a); l == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	l, _, _ := lastSeen(a)
	t.Fatalf("settled counter = %d, want %d without any GetStats", l, want)
}

func TestTheCountersAreReadWithoutThePanelPolling(t *testing.T) {
	a := newTestAdapter(t)
	c := newCounters(t)
	c.set("u1", 150) // already there when the quota is pushed: the base
	quotaAdapter(t, a, c, 1000)
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	waitLast(t, a, 150) // first reading is the base
	c.set("u1", 400)
	waitLast(t, a, 400)
	if _, rem, _ := lastSeen(a); rem != 750 {
		t.Errorf("remaining = %d, want 750", rem)
	}
}

func TestNoCounterReaderWithoutAQuotaAndStopEndsIt(t *testing.T) {
	a := newTestAdapter(t)
	c := newCounters(t)
	a.cfg.MetricsURL = c.srv.URL
	a.cfg.QuotaPollEvery = 50 * time.Millisecond
	startAdapter(t, a)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	if _, _, running := lastSeen(a); running {
		t.Error("a counter reader runs with no quota held")
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(500)}); err != nil {
		t.Fatal(err)
	}
	if _, _, running := lastSeen(a); !running {
		t.Error("no counter reader although a user has a quota")
	}
	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	if _, _, running := lastSeen(a); running {
		t.Error("the counter reader outlived the last quota")
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA, MtprotoQuotaBytes: quota(500)}); err != nil {
		t.Fatal(err)
	}
	if err := a.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, _, running := lastSeen(a); running {
		t.Error("Stop left the counter reader running")
	}
	startAdapter(t, a)
	if _, _, running := lastSeen(a); !running {
		t.Fatal("no counter reader after the restart")
	}
	if err := a.Idle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, _, running := lastSeen(a); running {
		t.Error("Idle left the counter reader running")
	}
}

func TestACrashRestartAfterSpendWithNoPanelWritesTheTrueRemainder(t *testing.T) {
	f := processFixture(t, true)
	a := f.a
	c := newCounters(t)
	quotaAdapter(t, a, c, 1000)
	time.Sleep(150 * time.Millisecond)
	c.set("u1", 100)
	waitLast(t, a, 100)
	c.set("u1", 700) // the panel never polls
	waitLast(t, a, 700)
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if err := proc.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for f.count(t, f.starts, "run") < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the supervisor did not respawn the process")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if q, _ := quotaOf(t, a, "u1"); q != 300 {
		t.Errorf("quota = %v after the crash-restart, want the true remainder 300 (not 900)", q)
	}
}

func TestStop_NoConfigRewriteForARestartAnnouncedAfterIt(t *testing.T) {
	// The supervisor announces a respawn from its own goroutine; the rewrite it
	// asks for must not land after Stop, where it outlives the adapter's files.
	f := processFixture(t, true)
	a := f.a
	if err := a.ApplyInbound(2083, domainPush); err != nil {
		t.Fatal(err)
	}
	if err := a.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(a.cfg.ConfigPath); err != nil {
		t.Fatal(err)
	}
	a.onProcessRestart(subprocess.RestartEvent{Reason: subprocess.RestartReasonCrash, Attempt: 1, Max: 5})
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(a.cfg.ConfigPath); err == nil {
		t.Error("the config was rewritten after Stop")
	}
}
