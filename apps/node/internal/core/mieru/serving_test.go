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

func withRunner(t *testing.T, r *scriptedRunner) *Adapter {
	t.Helper()
	return New(Config{
		BinaryPath: "/usr/bin/mita",
		ConfigPath: filepath.Join(t.TempDir(), "server.json"),
		Inbound:    InboundConfig{ListenPort: 2012, MTU: 1400, LoggingLevel: "INFO"},
		RunCmd:     r.run,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
