package mieru

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// mita has TWO states, and for the whole life of this adapter only one of them
// was managed.
//
// The systemd unit runs an RPC server that answers `apply config`, `reload` and
// `status`; the PROXY inside it opens its sockets only on `mita start`. Both
// `apply config` and `reload` answer rc=0 - and `reload` prints "mita server is
// reloaded" - against a proxy that is IDLE and listening on nothing. Measured
// on a live node 2026-08-30: config accepted in full (`mita describe config`
// showed the pushed port, the pushed mtu and all 16 users), unit
// `active (running)`, agent logging "mieru (mita) reloaded", panel reporting
// `running: true, drift: false` on an `online` node - and `ss` listing not one
// socket on the inbound's port. `mita start` then made it serve immediately.
//
// So mieru had never carried a byte on any node, the same way sing-box had not
// before it was asked for its build tags. Both were found the same way: by
// asking the binary instead of the code that drives it. mita's own help says
// "reload ... WITHOUT stopping proxy service" - it presumes a running proxy.

// scriptedRunner records every invocation and answers `status` from a value the
// test controls, so "what did the adapter run" and "what did mita say" are two
// separate knobs.
type scriptedRunner struct {
	mu       sync.Mutex
	calls    [][]string
	status   string // the exact stdout of `mita status`
	failOn   string // subcommand that returns an error
	statuses int    // how many times `status` was asked
}

func (r *scriptedRunner) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, append([]string{name}, args...))
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	if sub == "status" {
		r.statuses++
		return []byte(r.status), nil
	}
	if r.failOn != "" && sub == r.failOn {
		return []byte("boom"), errors.New("fake " + sub + " failure")
	}
	return nil, nil
}

func (r *scriptedRunner) ran(sub string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.calls {
		if len(c) > 1 && c[1] == sub {
			return true
		}
	}
	return false
}

func (r *scriptedRunner) order() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.calls))
	for _, c := range r.calls {
		if len(c) > 1 && c[1] != "status" {
			out = append(out, c[1])
		}
	}
	return out
}

// withRunner builds an adapter that already has a user, because mita refuses to
// start a proxy without one and every case below is about what happens AFTER
// that point. The empty-user case has its own test.
func withRunner(t *testing.T, r *scriptedRunner) *Adapter {
	t.Helper()
	a := New(Config{
		BinaryPath: "/usr/bin/mita",
		ConfigPath: filepath.Join(t.TempDir(), "server.json"),
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     r.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.users["u-1"] = User{Name: "alice", Password: "uuid-a"}
	return a
}

func TestStartActuallyStartsTheProxy(t *testing.T) {
	r := &scriptedRunner{status: `mita server status is "RUNNING"`}
	a := withRunner(t, r)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !r.ran("start") {
		t.Fatalf("the adapter never ran `mita start`, so the proxy stays IDLE and the port "+
			"is never opened; it ran %v", r.order())
	}
	// Order is part of the contract: starting before the config is applied
	// would serve the previous one.
	got := strings.Join(r.order(), ",")
	if !strings.HasPrefix(got, "apply,") {
		t.Errorf("config must be applied before the proxy is started; ran %v", r.order())
	}
	if idx := strings.Index(got, "start"); idx >= 0 && idx < strings.Index(got, "apply") {
		t.Errorf("start ran before apply; ran %v", r.order())
	}
}

func TestApplyInboundStartsTheProxy(t *testing.T) {
	// The push path, not just boot: a node whose inbound arrives after the
	// agent is up gets its proxy started by the push.
	r := &scriptedRunner{status: `mita server status is "RUNNING"`}
	a := withRunner(t, r)
	if err := a.ApplyInbound(2012, []byte(`{"mtu":1380}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if !r.ran("start") {
		t.Fatalf("a pushed inbound left the proxy unstarted; ran %v", r.order())
	}
}

func TestAFailingStartIsReportedNotSwallowed(t *testing.T) {
	// `reload` is warn-and-continue on purpose (it is optional after apply).
	// `start` is not: if it fails the core serves nobody, and a push that
	// answers OK is the silence this whole thing is about.
	r := &scriptedRunner{status: `mita server status is "IDLE"`, failOn: "start"}
	a := withRunner(t, r)
	if err := a.Start(context.Background()); err == nil {
		t.Fatal("mita start failed and the adapter reported success")
	}
}

func TestHealthyAsksMitaNotItsOwnFlag(t *testing.T) {
	r := &scriptedRunner{status: `mita server status is "IDLE"`, failOn: "start"}
	a := withRunner(t, r)
	// Force the adapter into the state it used to report as healthy: a config
	// it rendered and applied successfully.
	_ = a.Start(context.Background())
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()
	a.invalidateStatus()
	if a.Healthy() {
		t.Fatal("Healthy() said yes while `mita status` said IDLE - which is the exact " +
			"state the panel reported as `running: true` on a node serving nothing")
	}
	if r.statuses == 0 {
		t.Fatal("Healthy() never asked mita anything")
	}
}

func TestHealthyIsTrueWhenMitaSaysRunning(t *testing.T) {
	// The control: a Healthy() hardwired to false would pass the case above.
	r := &scriptedRunner{status: `mita server status is "RUNNING"`}
	a := withRunner(t, r)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	a.invalidateStatus()
	if !a.Healthy() {
		t.Fatal("Healthy() said no while mita reported RUNNING")
	}
}

func TestUnchangedConfigStillStartsAnIdleProxy(t *testing.T) {
	// A resync that renders the same bytes skips the CLI - which is right while
	// the core is serving them, and wrong the moment it is not. This is the
	// path an agent restart or an out-of-band `mita stop` takes.
	r := &scriptedRunner{status: `mita server status is "RUNNING"`}
	a := withRunner(t, r)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	before := len(r.order())

	// Same config, proxy still up: nothing should be re-run.
	a.invalidateStatus()
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start #2: %v", err)
	}
	if len(r.order()) != before {
		t.Errorf("an unchanged config with a running proxy re-ran the CLI: %v", r.order())
	}

	// Same config, proxy gone: it must be started again.
	r.mu.Lock()
	r.status = `mita server status is "IDLE"`
	r.mu.Unlock()
	a.invalidateStatus()
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start #3: %v", err)
	}
	if len(r.order()) <= before {
		t.Errorf("an unchanged config with an IDLE proxy was skipped, so the resync repaired "+
			"nothing: %v", r.order())
	}
}

func TestStatusAnswerIsCachedButNotForever(t *testing.T) {
	r := &scriptedRunner{status: `mita server status is "RUNNING"`}
	a := withRunner(t, r)
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	a.invalidateStatus()
	for i := 0; i < 5; i++ {
		a.Healthy()
	}
	r.mu.Lock()
	burst := r.statuses
	r.mu.Unlock()
	if burst != 1 {
		t.Errorf("five healthchecks in a row cost %d forks, want 1", burst)
	}
	// And the cache has to expire, or a proxy that stops is reported healthy
	// forever - the failure this replaced, with a timer on it.
	a.statusMu.Lock()
	a.statusAt = time.Now().Add(-2 * statusCacheFor)
	a.statusMu.Unlock()
	a.Healthy()
	r.mu.Lock()
	after := r.statuses
	r.mu.Unlock()
	if after != burst+1 {
		t.Errorf("the cached status never expired: asked %d times, want %d", after, burst+1)
	}
}

func TestStartDefersInsteadOfKillingTheAgentWithNoUsers(t *testing.T) {
	// mita answers `no user found` and exits 1. main.go treats a Start error as
	// fatal and calls os.Exit(1), so returning that error puts a freshly
	// installed mieru node into a systemd restart loop - and the agent is then
	// never up long enough to receive the users that would let mita start. The
	// node could only be repaired by the thing it was refusing to run.
	//
	// Measured live 2026-08-30: the agent restarted every five seconds logging
	// `start adapter name=mieru err="mita start: exit status 1 (... no user
	// found)"` until the users arrived.
	r := &scriptedRunner{status: `mita server status is "IDLE"`, failOn: "start"}
	a := withRunner(t, r)
	a.users = map[string]User{}

	if a.Provisioned() {
		t.Fatal("an adapter with no users called itself provisioned")
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatalf("Start must defer, not fail - main.go exits the agent on this error: %v", err)
	}
	if r.ran("start") {
		t.Errorf("ran `mita start` with no users, which mita refuses; ran %v", r.order())
	}
	if a.Healthy() {
		t.Error("an adapter that deferred reported healthy")
	}

	// ...and what ends the deferral is the panel's inbound push, which renders
	// whatever users have arrived in the meantime and starts the proxy. A mieru
	// node with users and no mieru inbound has nothing to serve.
	r.mu.Lock()
	r.failOn, r.status = "", `mita server status is "RUNNING"`
	r.mu.Unlock()
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if err := a.ApplyInbound(2012, []byte(`{"mtu":1380}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if !r.ran("start") {
		t.Errorf("the inbound push did not start the proxy; ran %v", r.order())
	}
	if !a.Healthy() {
		t.Error("still unhealthy after the push that started it")
	}
}

func TestConfigOnlyModeIsNotHealthyWithoutUsersEither(t *testing.T) {
	// With no binary there is no mita to ask, and the fallback is this
	// adapter's own "did my last write succeed" flag - which ApplyInbound sets
	// even when it deliberately did NOT start the proxy, because the node had
	// no users yet. Without the provisioning check, that state reports healthy
	// in config-only mode and unhealthy with a binary: the same node, two
	// answers, decided by whether mita happens to be installed.
	a := New(Config{
		ConfigPath: filepath.Join(t.TempDir(), "server.json"),
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := a.ApplyInbound(2012, []byte(`{"mtu":1380}`)); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if a.Healthy() {
		t.Error("reported healthy after applying a config with no users, which mita would refuse to serve")
	}

	// The control: with a user it does report healthy, so this is not a
	// Healthy() that simply says no.
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if !a.Healthy() {
		t.Error("still unhealthy once it had a user and a rendered config")
	}
}

func TestAnInboundPushedBeforeAnyUserDoesNotFail(t *testing.T) {
	// The order an operator can easily produce: install a mieru node, bind a
	// mieru profile to it, and only then put someone in the squad. The push
	// arrives with the user list still empty, and mita would refuse to start.
	//
	// Refusing back is the wrong answer: ApplyInbound's error becomes
	// "1/1 inbounds failed to apply" in the panel, on a node whose only problem
	// is that nobody has been given access yet. The config is applied, the
	// proxy waits, and the first user starts it.
	r := &scriptedRunner{status: `mita server status is "IDLE"`, failOn: "start"}
	a := withRunner(t, r)
	a.users = map[string]User{}

	if err := a.ApplyInbound(2012, []byte(`{"mtu":1380}`)); err != nil {
		t.Fatalf("a push to a node with no users failed: %v", err)
	}
	if r.ran("start") {
		t.Errorf("ran `mita start` with no users, which mita refuses; ran %v", r.order())
	}
	if !r.ran("apply") {
		t.Errorf("the config was not applied either; ran %v", r.order())
	}

	r.mu.Lock()
	r.failOn, r.status = "", `mita server status is "RUNNING"`
	r.mu.Unlock()
	if err := a.AddUser(core.User{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"}); err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if !r.ran("start") {
		t.Errorf("the first user did not start the waiting proxy; ran %v", r.order())
	}
}
