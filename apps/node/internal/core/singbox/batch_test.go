package singbox

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-119, 22.10. The timings are scaled down from the real 2 s / 10 s (quiet
// 40 ms, cap 200 ms); the rule they test is the same.
//
// The batch's time is a stepClock: the quiet window and the cap are rules
// about when a restart is DECIDED, and a test that read them off the wall
// clock measured how fast a loaded runner was instead (a 310 ms gap against a
// 200 ms cap under a parallel go test ./..., 26.10).

// stepClock is time that moves only when the test says so. Advance fires every
// timer that falls due, in order, each with Now at its own moment.
type stepClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*stepTimer
}

type stepTimer struct {
	c              *stepClock
	at             time.Time
	f              func()
	stopped, fired bool
}

func (t *stepTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := !t.stopped && !t.fired
	t.stopped = true
	return was
}

func newStepClock() *stepClock { return &stepClock{now: time.Unix(1_800_000_000, 0)} }

func (c *stepClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *stepClock) AfterFunc(d time.Duration, f func()) stopper {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &stepTimer{c: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (c *stepClock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var next *stepTimer
		for _, t := range c.timers {
			if !t.stopped && !t.fired && !t.at.After(end) && (next == nil || t.at.Before(next.at)) {
				next = t
			}
		}
		if next == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		c.now = next.at
		next.fired = true
		c.mu.Unlock()
		next.f()
	}
}

type flushLog struct {
	mu    sync.Mutex
	times []time.Time
}

func (f *flushLog) all() []time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]time.Time(nil), f.times...)
}

// stepped hands the adapter a stepClock and records, by it, the moment each
// batch decides to restart.
func stepped(a *Adapter) (*stepClock, *flushLog) {
	clk, log := newStepClock(), &flushLog{}
	a.mu.Lock()
	a.clock = clk
	a.onFlush = func() {
		log.mu.Lock()
		log.times = append(log.times, clk.Now())
		log.mu.Unlock()
	}
	a.mu.Unlock()
	return clk, log
}

// countingAdapter runs a stub sing-box that writes a line on every start
// beside its config.
func countingAdapter(t *testing.T) (*Adapter, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "sing-box-stub")
	// `version` answers at once (the adapter asks it for its build tags).
	// `check` refuses a config that names "refuse-me" (A-110 test).
	script := "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'sing-box version 1.13.14'; exit 0; fi\n" +
		"if [ \"$1\" = check ]; then if grep -q refuse-me \"$3\"; then echo 'FATAL refused'; exit 1; fi; exit 0; fi\n" +
		"echo start >> \"$(dirname \"$3\")/starts\"\nexec sleep 60\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	a := New(Config{
		Protocol:    "tuic",
		BinaryPath:  bin,
		ConfigPath:  filepath.Join(dir, "config.json"),
		QuietWindow: 40 * time.Millisecond,
		MaxWait:     200 * time.Millisecond,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	if err := a.ApplyInbound(9443, []byte(`{"serverName":"n.example.test"}`)); err != nil {
		t.Fatal(err)
	}
	starts := filepath.Join(dir, "starts")
	// The push's own start, written by the stub once it runs: an event to
	// wait for, with a deadline only for a stub that never comes up.
	waitStarts(t, starts, 1)
	return a, starts
}

func startCount(path string) int {
	body, _ := os.ReadFile(path)
	return strings.Count(string(body), "start")
}

func waitStarts(t *testing.T, path string, n int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); startCount(path) < n; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the stub started %d times, waited for %d", startCount(path), n)
		}
	}
}

func user(i int) core.User {
	return core.User{UserID: fmt.Sprintf("u-%d", i), TuicUUID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), TuicPassword: "p"}
}

// 1000 users added in a row: one restart after the push's own, not 1000.
func TestAThousandAddsAreOneRestart(t *testing.T) {
	a, path := countingAdapter(t)
	clk, log := stepped(a)
	base := startCount(path)
	for i := 0; i < 1000; i++ {
		if err := a.AddUser(user(i)); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(log.all()); got != 0 {
		t.Fatalf("%d restarts decided before the quiet window passed", got)
	}
	// The quiet window and more: the one batch fires (and restarts, in the
	// same call), and nothing is left pending to fire after it.
	clk.Advance(time.Second)
	if got := len(log.all()); got != 1 {
		t.Fatalf("%d restart decisions for 1000 adds, want 1", got)
	}
	waitStarts(t, path, base+1)
	if got := startCount(path) - base; got != 1 {
		t.Fatalf("%d process starts for 1000 adds, want 1", got)
	}
	blob, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "config.json"))
	if !strings.Contains(string(blob), "00000000-0000-4000-8000-000000000999") {
		t.Fatal("the last user of the batch is not in the config")
	}
}

// A batch that fires while the adapter is being stopped: the Stop lands after
// the batch has decided to restart and before it renders. The adapter is
// stopped, so no process may come up after it (AUDT, 22.10: Stop did not take
// restartMu and the render did not look at started).
func TestAStopDuringABatchLeavesNoProcess(t *testing.T) {
	a, path := countingAdapter(t)
	clk, _ := stepped(a)
	stopped := false
	a.mu.Lock()
	a.onFlush = func() {
		_ = a.Stop(context.Background())
		stopped = true
	}
	a.mu.Unlock()
	base := startCount(path)
	if err := a.AddUser(user(1)); err != nil {
		t.Fatal(err)
	}
	clk.Advance(time.Second)
	if !stopped {
		t.Fatal("the batch never fired")
	}
	a.mu.Lock()
	proc := a.proc
	a.mu.Unlock()
	if proc != nil || startCount(path) != base {
		t.Fatalf("a process came up after Stop: proc=%v starts +%d", proc != nil, startCount(path)-base)
	}
}

// A steady stream of changes, every 10 ms against a 40 ms quiet window, for
// 1.15 s: the quiet window never comes, so each of five batches is decided
// exactly at the cap from its first change, and the sixth a quiet window after
// the stream stops, before its cap. Never put off forever, never early.
func TestASteadyStreamStillRestartsWithinTheCap(t *testing.T) {
	// The rule alone: an adapter with nothing to run, so a decided restart
	// renders nothing and the decisions are all that is counted.
	a := New(Config{Protocol: "tuic", QuietWindow: 40 * time.Millisecond, MaxWait: 200 * time.Millisecond},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	clk, log := stepped(a)

	var adds []time.Time
	for i := 0; i < 115; i++ {
		adds = append(adds, clk.Now())
		a.scheduleRestart()
		clk.Advance(10 * time.Millisecond)
	}
	clk.Advance(300 * time.Millisecond)

	flushes := log.all()
	if len(flushes) != 6 {
		t.Fatalf("%d restart decisions over 1.15 s of steady changes, want 5 at the cap and the last one", len(flushes))
	}
	first := adds[0]
	for i, f := range flushes[:len(flushes)-1] {
		if got := f.Sub(first); got != 200*time.Millisecond {
			t.Fatalf("batch %d decided %v after its first change, the cap is 200 ms", i, got)
		}
		// The next batch begins with the first change from this decision on
		// (the change at the same instant comes after it: Advance fired it).
		for _, at := range adds {
			if !at.Before(f) {
				first = at
				break
			}
		}
	}
	if got := flushes[len(flushes)-1].Sub(adds[len(adds)-1]); got != 40*time.Millisecond {
		t.Fatalf("the last batch decided %v after the last change, the quiet window is 40 ms", got)
	}
}
